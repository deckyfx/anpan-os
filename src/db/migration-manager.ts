import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { sql } from "drizzle-orm";
import { config } from "../config";
import { envConfig } from "../env-config";
import { embeddedMigrations, embeddedMigrationCount } from "./migrations-embedded";
import { mkdirSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
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

    // A binary with no migrations compiled in cannot create its schema, and continuing
    // would leave every query failing on a missing table. That is a build fault, not a
    // configuration the user can be expected to fix, so say so and stop.
    if (embeddedMigrationCount === 0) {
      console.error("❌ No migrations were compiled into this build — the database cannot be created.");
      console.error("💡 This is a packaging fault; please report it.");
      process.exit(1);
    }

    await this.materialise();

    const hasMigrations = await this.hasMigrationFiles();
    if (!hasMigrations) {
      console.error(`❌ Could not write migrations to ${this.migrationsDir}`);
      process.exit(1);
    }

    const pendingCount = await this.getPendingCount();

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
    // apply nothing while reporting success.
    await this.materialise();

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
