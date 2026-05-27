/**
 * Bun test preload — runs in each worker before test files are loaded.
 * Sets RUNTIME_CONFIG_DIR to an isolated temp directory so tests use
 * a separate SQLite database instead of the dev database.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";

const TEST_DIR = "./configs/anpan-test";
mkdirSync(TEST_DIR, { recursive: true });

// Must be set before any src/ module is imported so db/index.ts picks it up.
process.env.RUNTIME_CONFIG_DIR = TEST_DIR;

// Run migrations against the test DB (idempotent — safe to call multiple times).
const sqlite = new Database(join(TEST_DIR, "storage.db"));
try { await migrate(drizzle(sqlite), { migrationsFolder: "./drizzle" }); } catch { /* ignore */ }
sqlite.close();
