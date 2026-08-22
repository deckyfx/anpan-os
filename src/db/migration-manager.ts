import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { sql } from "drizzle-orm";
import { config } from "../config";
import { envConfig } from "../env-config";
import { embeddedMigrations, embeddedMigrationCount } from "./migrations-embedded";
import { mkdirSync } from "node:fs";
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
  private static readonly migrationsDir = join(envConfig.RUNTIME_CONFIG_DIR, ".migrations");

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
    try { existing = await readdir(this.migrationsDir); } catch { /* first run */ }
    await Promise.all(
      existing
        .filter(f => f.endsWith(".sql") && !expected.has(f))
        .map(f => rm(join(this.migrationsDir, f), { force: true })),
    );

    await Bun.write(join(this.migrationsDir, "meta", "_journal.json"), embeddedMigrations.journal);
    await Promise.all(
      Object.entries(embeddedMigrations.files)
        .map(([name, sql]) => Bun.write(join(this.migrationsDir, name), sql)),
    );
  }

  /** Initialize migration system on app startup. */
  static async init(migrationConfig: MigrationConfig = {}): Promise<void> {
    const { strict = false, autoMigrate = false } = migrationConfig;

    await this.materialise();

    const hasMigrations = await this.hasMigrationFiles();
    if (!hasMigrations) {
      console.error(`❌ Could not write migrations to ${this.migrationsDir}`);
      process.exit(1);
    }

    const { pending: pendingCount } = await this.preflight();

    if (pendingCount === 0) {
      console.log("✅ Database is up to date");
      return;
    }

    if (strict) {
      console.error(`❌ ${pendingCount} pending migration(s) detected`);
      console.error("💡 Run 'bun run migrate' to apply migrations");
      process.exit(1);
    }

    if (autoMigrate) {
      console.log(`🔄 Auto-migrating ${pendingCount} pending migration(s)...`);
      await this.runMigrations();
      console.log("✅ Auto-migration completed");
      return;
    }

    console.warn(`⚠️  Warning: ${pendingCount} pending migration(s) detected`);
    console.warn("💡 Run 'bun run migrate' to apply them");
  }

  /** Run all pending migrations (for CLI use). */
  static async runMigrations(): Promise<void> {
    // Also called directly by `bun run migrate`, which never goes through init(). Without
    // this the CLI would find an empty migrations directory on a clean runtime dir and
    // apply nothing while reporting success — and would skip the checks that stop a
    // migration being applied over a schema from another branch.
    await this.materialise();
    await this.preflight();

    console.log("🚀 Running migrations...\n");

    const sqlite = new Database(config.databasePath);
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
  private static async analyse(): Promise<{ pending: number; problem: string | null }> {
    // Ordered as the journal orders them, with the same timestamp Drizzle records as
    // created_at, so the build's sequence and the database's are directly comparable.
    const journal = JSON.parse(embeddedMigrations.journal) as {
      entries: Array<{ tag: string; when: number }>;
    };
    const buildSeq = journal.entries.map(e => ({
      when: e.when,
      hash: createHash("sha256")
        .update(embeddedMigrations.files[`${e.tag}.sql`] ?? "")
        .digest("hex"),
      tag: e.tag,
    }));

    const sqlite = new Database(config.databasePath);
    const db = drizzle(sqlite);
    try {
      const tracking = await db.all<{ name: string }>(
        sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'`,
      );
      if (tracking.length === 0) return { pending: buildSeq.length, problem: null };

      let rows: Array<{ hash: string; created_at: number }>;
      try {
        rows = await db.all<{ hash: string; created_at: number }>(
          sql`SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at ASC`,
        );
      } catch (err) {
        console.error("❌ The migration history exists but could not be read.");
        console.error(`💡 ${err instanceof Error ? err.message : String(err)}`);
        console.error("💡 The database may be corrupt or written by an incompatible tool.");
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
        return { pending: 0, problem: `the database has ${rows.length - buildSeq.length} migration(s) beyond this build` };
      }
      for (const [i, row] of rows.entries()) {
        const expected = buildSeq[i];
        if (!expected || row.hash !== expected.hash) {
          return {
            pending: 0,
            problem: `applied migration ${i + 1} does not match this build (expected ${expected?.tag ?? "nothing"})`,
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
      console.error("❌ No migrations were compiled into this build — the database cannot be created.");
      console.error("💡 This is a packaging fault; please report it.");
      process.exit(1);
    }

    const { pending, problem } = await this.analyse();
    if (problem) {
      console.error(`❌ The database does not match this build: ${problem}.`);
      console.error("💡 This build is older than the database, or from a different branch.");
      console.error("💡 Restore a matching build, or downgrade the database deliberately.");
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
      const db = drizzle(sqlite);

      try {
        const result = await db.all<{ count: number }>(
          sql`SELECT COUNT(*) as count FROM __drizzle_migrations`
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
