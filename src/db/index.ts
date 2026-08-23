import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { config } from "../config";

const sqlite = new Database(config.databasePath);
// Wait for a competing writer rather than failing instantly. Without this, a second
// process starting while the first is migrating dies here at import time — setting WAL
// needs an exclusive lock, and this module is loaded long before any migration guard runs.
sqlite.run("PRAGMA busy_timeout = 15000;");

// Switching journal modes needs exclusive access, and SQLite does not run the busy
// handler for it — so busy_timeout above does not cover this one statement. Several
// processes starting together against a brand-new database therefore raced here and
// some died with SQLITE_BUSY before any migration lock could exist, because this runs
// at import time. Retry briefly, and treat continued failure as non-fatal: the mode is
// a property of the file, so whichever process wins sets it for everyone, and rollback
// journalling is slower but correct in the meantime.
for (let attempt = 0; ; attempt++) {
  try {
    sqlite.run("PRAGMA journal_mode = WAL;");
    break;
  } catch (err) {
    if (attempt >= 20) {
      console.warn(`⚠️  Could not enable WAL mode (${(err as Error).message}) — continuing`);
      break;
    }
    Bun.sleepSync(100);
  }
}

export const db = drizzle(sqlite);
