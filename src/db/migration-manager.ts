import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { sql } from "drizzle-orm";
import { config } from "../config";
import { envConfig } from "../env-config";
import {
  embeddedMigrations,
  embeddedMigrationCount,
} from "./migrations-embedded";
import { mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";

export interface MigrationConfig {
  /** Terminate if pending migrations detected. Default: false */
  strict?: boolean;
  /** Automatically run pending migrations. Default: false */
  autoMigrate?: boolean;
}

/** Migration manager — workflow layer on top of Drizzle's bun-sqlite migrator. */
export class MigrationManager {
  /**
   * Where the migrator reads SQL from.
   *
   * Not the repository's drizzle/ folder: that path is relative to the working directory,
   * and a compiled binary runs from /var/lib/anpan-os where no such folder exists. The
   * result was a fresh install creating *no tables at all* while logging "No migration
   * files found" — a broken state reported as an empty one.
   *
   * The migrations are compiled into the binary and written here on startup, so Drizzle's
   * migrator and its __drizzle_migrations bookkeeping behave exactly as before and an
   * existing database re-runs nothing.
   */
  private static readonly migrationsDir = join(
    envConfig.RUNTIME_CONFIG_DIR,
    ".migrations",
  );

  /** Lock directory guarding materialise → preflight → migrate. */
  private static readonly lockDir = join(
    envConfig.RUNTIME_CONFIG_DIR,
    ".migrations.lock",
  );

  /** A lock older than this is assumed abandoned even if its PID check is inconclusive. */
  private static readonly LOCK_STALE_MS = 5 * 60_000;

  /**
   * Run `fn` with exclusive access to the migration sequence.
   *
   * Two processes can reach this at once — a service restart overlapping its predecessor,
   * or `bun run migrate` while the service is up. Without a lock they both rewrite the
   * migrations directory, and an older build can delete the very files a newer one is
   * midway through applying.
   *
   * mkdir is the lock: it is atomic on every platform this runs on, unlike a
   * check-then-create on a file. The PID recorded inside lets a genuinely abandoned lock
   * be reclaimed, which matters because preflight() exits the process on a mismatch and
   * would otherwise leave the directory behind forever.
   */
  private static async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const deadline = Date.now() + 30_000;

    for (;;) {
      try {
        mkdirSync(this.lockDir); // throws if it already exists
        writeFileSync(join(this.lockDir, "pid"), this.ownerToken());
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;

        if (this.lockIsAbandoned()) {
          console.warn("⚠️  Reclaiming an abandoned migration lock");
          rmSync(this.lockDir, { recursive: true, force: true });
          continue;
        }
        if (Date.now() > deadline) {
          console.error(
            "❌ Another process is migrating and did not finish within 30s.",
          );
          console.error(`💡 If nothing is running, remove ${this.lockDir}`);
          process.exit(1);
        }
        await Bun.sleep(250);
      }
    }

    const pidFile = join(this.lockDir, "pid");
    const token = this.ownerToken();

    // Refresh the token while the work runs. The age check measures time since
    // acquisition, so a migration slower than LOCK_STALE_MS would otherwise look
    // abandoned: another process would reclaim the lock mid-run, and the original would
    // then delete *its* lock on the way out — losing mutual exclusion in exactly the slow
    // case the lock exists to protect.
    const heartbeat = setInterval(() => {
      try {
        writeFileSync(pidFile, token);
      } catch {
        /* reclaimed or removed — the ownership check below handles it */
      }
    }, Math.floor(this.LOCK_STALE_MS / 4));

    try {
      return await fn();
    } finally {
      clearInterval(heartbeat);
      // Release only a lock still recorded as ours. If it was reclaimed despite the
      // heartbeat, removing it here would evict whoever holds it now.
      let stillOurs = false;
      try { stillOurs = readFileSync(pidFile, "utf8").trim() === token; } catch { /* gone */ }
      if (stillOurs) rmSync(this.lockDir, { recursive: true, force: true });
    }
  }

  /** True when the lock's owner is gone, or it is old enough to be presumed dead. */
  /**
   * Identify the lock owner as more than a PID.
   *
   * A PID alone is ambiguous: the owner can die and the number be reused, after which a
   * liveness check reports "held" forever and every start fails until someone deletes a
   * directory they do not know exists. Linux exposes a process start time in field 22 of
   * /proc/<pid>/stat, and the pair is unique for as long as the machine is up.
   */
  private static ownerToken(): string {
    return `${process.pid}:${this.startTimeOf(process.pid) ?? "?"}`;
  }

  /** Process start time in clock ticks, or null where /proc is unavailable. */
  private static startTimeOf(pid: number): string | null {
    try {
      // comm can contain spaces and parentheses, so parse after the last ')'.
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null;
    } catch {
      return null;
    }
  }

  /** True when the lock's owner is gone, or it is old enough to be presumed dead. */
  private static lockIsAbandoned(): boolean {
    let recordedPid: number | null = null;
    let recordedStart: string | null = null;
    try {
      const [pidPart, startPart] = readFileSync(join(this.lockDir, "pid"), "utf8").trim().split(":");
      const parsed = Number.parseInt(pidPart ?? "", 10);
      if (Number.isFinite(parsed) && parsed > 0) recordedPid = parsed;
      recordedStart = startPart && startPart !== "?" ? startPart : null;
    } catch {
      /* unreadable — fall through to the age check */
    }

    if (recordedPid !== null) {
      let alive = true;
      try { process.kill(recordedPid, 0); } catch { alive = false; }
      if (!alive) return true;

      // Alive, but the same process? A start time that does not match means the number
      // was recycled and the real owner is long gone.
      const currentStart = this.startTimeOf(recordedPid);
      if (recordedStart && currentStart && recordedStart !== currentStart) return true;

      // Same process, or start times unavailable — fall through to the age check rather
      // than declaring the lock held indefinitely.
    }

    try {
      const age = Date.now() - Bun.file(join(this.lockDir, "pid")).lastModified;
      return age > this.LOCK_STALE_MS;
    } catch {
      return true; // no pid file at all
    }
  }

  /**
   * Write the embedded migrations to disk.
   *
   * Rewritten on every start rather than only when absent: the files must match the binary
   * that is running, not whichever version last wrote them.
   *
   * Files this binary does not carry are deleted first. Overwriting alone would leave
   * behind SQL from a newer build after a rollback, and getPendingCount() counts every
   * .sql file present — so the older binary would report migrations pending that its own
   * journal cannot run.
   */
  private static async materialise(): Promise<void> {
    mkdirSync(join(this.migrationsDir, "meta"), { recursive: true });

    const expected = new Set(Object.keys(embeddedMigrations.files));
    let existing: string[] = [];
    try {
      existing = await readdir(this.migrationsDir);
    } catch {
      /* first run */
    }
    await Promise.all(
      existing
        .filter((f) => f.endsWith(".sql") && !expected.has(f))
        .map((f) => rm(join(this.migrationsDir, f), { force: true })),
    );

    await Bun.write(
      join(this.migrationsDir, "meta", "_journal.json"),
      embeddedMigrations.journal,
    );
    await Promise.all(
      Object.entries(embeddedMigrations.files).map(([name, sql]) =>
        Bun.write(join(this.migrationsDir, name), sql),
      ),
    );
  }

  /** Initialize migration system on app startup. */
  static async init(migrationConfig: MigrationConfig = {}): Promise<void> {
    const { strict = false, autoMigrate = false } = migrationConfig;

    // Held across the whole sequence, not just the write: another process must not be
    // able to rewrite the directory between our materialise and our migrate.
    const { pending, migrated } = await this.withLock(async () => {
      await this.materialise();

      if (!(await this.hasMigrationFiles())) {
        console.error(`❌ Could not write migrations to ${this.migrationsDir}`);
        process.exit(1);
      }

      const { pending: count } = await this.preflight();

      // Migrating inside the lock, rather than reporting a count and applying it after,
      // is the point: between the two another process could change what is pending.
      if (count > 0 && autoMigrate) {
        console.log(`🔄 Auto-migrating ${count} pending migration(s)...`);
        await this.applyMigrations();
        console.log("✅ Auto-migration completed");
        return { pending: 0, migrated: true };
      }
      return { pending: count, migrated: false };
    });

    if (migrated) return;

    if (pending === 0) {
      console.log("✅ Database is up to date");
      return;
    }

    if (strict) {
      console.error(`❌ ${pending} pending migration(s) detected`);
      console.error("💡 Run 'bun run migrate' to apply migrations");
      process.exit(1);
    }

    console.warn(`⚠️  Warning: ${pending} pending migration(s) detected`);
    console.warn("💡 Run 'bun run migrate' to apply them");
  }

  /** Run all pending migrations (for CLI use). */
  static async runMigrations(): Promise<void> {
    // Also called directly by `bun run migrate`, which never goes through init(), so it
    // needs the same lock, materialisation and checks — otherwise the CLI can race the
    // service and skip the guards that stop a migration landing on a foreign schema.
    return this.withLock(async () => {
      await this.materialise();
      await this.preflight();
      await this.applyMigrations();
    });
  }

  /** Apply pending migrations. Callers must already hold the lock. */
  private static async applyMigrations(): Promise<void> {
    console.log("🚀 Running migrations...\n");

    const sqlite = new Database(config.databasePath);
    sqlite.run("PRAGMA busy_timeout = 15000;");
    const db = drizzle(sqlite);

    try {
      await migrate(db, { migrationsFolder: this.migrationsDir });
      console.log("\n🎉 Migrations completed successfully");
    } catch (error) {
      console.error("\n❌ Migration failed:", error);
      throw error;
    } finally {
      sqlite.close();
    }
  }

  private static async hasMigrationFiles(): Promise<boolean> {
    try {
      const glob = new Bun.Glob("*.sql");
      for await (const _ of glob.scan(this.migrationsDir)) {
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  /** Compare migration files vs Drizzle's __drizzle_migrations tracking table. */
  /**
   * Compare the migrations this build carries against those the database records.
   *
   * Counting alone cannot tell `[A, C]` from `[A, B]` — both are two — so a database
   * migrated by a divergent branch passes a count check while carrying a schema this
   * build never produced. Drizzle stores the SHA-256 of each raw .sql file, verified
   * against a live database, so the hashes are the reliable comparison.
   *
   * `unknown` are hashes the database has and this build does not: a rollback, or a
   * branch that diverged. Either way the schema contains changes this code does not know
   * about.
   */
  private static async analyse(): Promise<{
    pending: number;
    problem: string | null;
  }> {
    // Ordered as the journal orders them, with the same timestamp Drizzle records as
    // created_at, so the build's sequence and the database's are directly comparable.
    const journal = JSON.parse(embeddedMigrations.journal) as {
      entries: Array<{ tag: string; when: number }>;
    };
    const buildSeq = journal.entries.map((e) => ({
      when: e.when,
      hash: createHash("sha256")
        .update(embeddedMigrations.files[`${e.tag}.sql`] ?? "")
        .digest("hex"),
      tag: e.tag,
    }));

    const sqlite = new Database(config.databasePath);
    sqlite.run("PRAGMA busy_timeout = 15000;");
    const db = drizzle(sqlite);
    try {
      const tracking = await db.all<{ name: string }>(
        sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'`,
      );
      if (tracking.length === 0)
        return { pending: buildSeq.length, problem: null };

      let rows: Array<{ hash: string; created_at: number }>;
      try {
        rows = await db.all<{ hash: string; created_at: number }>(
          sql`SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at ASC`,
        );
      } catch (err) {
        console.error("❌ The migration history exists but could not be read.");
        console.error(`💡 ${err instanceof Error ? err.message : String(err)}`);
        console.error(
          "💡 The database may be corrupt or written by an incompatible tool.",
        );
        process.exit(1);
      }

      // The applied migrations must be an ordered prefix of this build's sequence.
      //
      // A membership test is not enough. Drizzle selects work by comparing each journal
      // timestamp against the single greatest created_at in the table, and never checks
      // individual hashes — so a database holding A and C, against a build of A, B, C,
      // reports one pending migration, skips B because C is already newer, and announces
      // success with B's schema change absent.
      if (rows.length > buildSeq.length) {
        return {
          pending: 0,
          problem: `the database has ${rows.length - buildSeq.length} migration(s) beyond this build`,
        };
      }
      for (const [i, row] of rows.entries()) {
        const expected = buildSeq[i];
        if (!expected) {
          return {
            pending: 0,
            problem: `applied migration ${i + 1} is beyond this build`,
          };
        }
        // Hash alone cannot tell two migrations apart when their SQL is identical: a
        // database recording only the later one would match positionally, and Drizzle
        // would then skip the earlier one because the recorded timestamp is already
        // newer. created_at holds the journal's `when`, which is unique per migration.
        // Stored as numeric, so it can come back as a string.
        if (
          row.hash !== expected.hash ||
          Number(row.created_at) !== expected.when
        ) {
          return {
            pending: 0,
            problem: `applied migration ${i + 1} does not match this build (expected ${expected.tag})`,
          };
        }
      }

      return { pending: buildSeq.length - rows.length, problem: null };
    } finally {
      sqlite.close();
    }
  }

  /**
   * Refuse to proceed when the build and the database cannot work together.
   *
   * Shared by init() and runMigrations() because `bun run migrate` calls the latter
   * directly: without this the CLI would skip both checks and could apply a migration on
   * top of a schema from another branch.
   */
  private static async preflight(): Promise<{ pending: number }> {
    if (embeddedMigrationCount === 0) {
      console.error(
        "❌ No migrations were compiled into this build — the database cannot be created.",
      );
      console.error("💡 This is a packaging fault; please report it.");
      process.exit(1);
    }

    const { pending, problem } = await this.analyse();
    if (problem) {
      console.error(`❌ The database does not match this build: ${problem}.`);
      console.error(
        "💡 This build is older than the database, or from a different branch.",
      );
      console.error(
        "💡 Restore a matching build, or downgrade the database deliberately.",
      );
      process.exit(1);
    }
    return { pending };
  }

  private static async getPendingCount(): Promise<number> {
    try {
      const glob = new Bun.Glob("*.sql");
      const migrationFiles = (
        await Array.fromAsync(glob.scan(this.migrationsDir))
      ).sort();

      if (migrationFiles.length === 0) return 0;

      const sqlite = new Database(config.databasePath);
      sqlite.run("PRAGMA busy_timeout = 15000;");
      const db = drizzle(sqlite);

      try {
        const result = await db.all<{ count: number }>(
          sql`SELECT COUNT(*) as count FROM __drizzle_migrations`,
        );
        const applied = result[0]?.count ?? 0;
        return migrationFiles.length - applied;
      } catch {
        return migrationFiles.length;
      } finally {
        sqlite.close();
      }
    } catch {
      return 0;
    }
  }
}
