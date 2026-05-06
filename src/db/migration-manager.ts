import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { createClient } from "@libsql/client";
import { config } from "../config";

export interface MigrationConfig {
  /** Terminate if pending migrations detected. Default: false */
  strict?: boolean;
  /** Automatically run pending migrations. Default: false */
  autoMigrate?: boolean;
}

/** Migration manager — workflow layer on top of Drizzle's LibSQL migrator. */
export class MigrationManager {
  private static readonly migrationsDir = "drizzle";

  /** Initialize migration system on app startup. */
  static async init(config: MigrationConfig = {}): Promise<void> {
    const { strict = false, autoMigrate = false } = config;

    const hasMigrations = await this.hasMigrationFiles();
    if (!hasMigrations) {
      console.log("ℹ️  No migration files found");
      return;
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
    console.log("🚀 Running migrations...\n");

    const client = createClient({ url: config.databaseUrl });
    const db = drizzle({ client });

    try {
      await migrate(db, { migrationsFolder: this.migrationsDir });
      console.log("\n🎉 Migrations completed successfully");
    } catch (error) {
      console.error("\n❌ Migration failed:", error);
      throw error;
    } finally {
      client.close();
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

      const client = createClient({ url: config.databaseUrl });

      try {
        const result = await client.execute(
          "SELECT COUNT(*) as count FROM __drizzle_migrations"
        );
        const applied = Number(result.rows[0]?.[0] ?? 0);
        return migrationFiles.length - applied;
      } catch {
        // Table doesn't exist yet — all migrations are pending
        return migrationFiles.length;
      } finally {
        client.close();
      }
    } catch {
      return 0;
    }
  }
}
