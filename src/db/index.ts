import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "../config";
import { envConfig } from "../env-config";
import { parseCli } from "../cli-parser";
import { abandonInstructions, applyPendingRestore } from "../lib/pending-restore";

/**
 * Create the runtime directory before opening the database.
 *
 * config.load() creates it, but this module runs at *import* time — long before that — so
 * on a host where the directory does not exist yet SQLite fails with SQLITE_CANTOPEN and
 * takes the whole process down, including `--version` and `--doctor`, which need no
 * database at all. On Linux this never surfaced because the installer creates
 * /var/lib/anpan-os before the binary ever runs; anywhere else, the first run is the
 * failing one.
 *
 * A failure here is reported rather than swallowed: an unwritable directory is a
 * permission problem the user can fix, and "unable to open database file" does not say
 * which file or why.
 */
const databasePath = config.databasePath;
try {
  mkdirSync(dirname(databasePath), { recursive: true });
} catch (err) {
  const reason = err instanceof Error ? err.message : String(err);
  console.error(
    `❌ Cannot create the runtime directory ${envConfig.RUNTIME_CONFIG_DIR}: ${reason}\n` +
    `   Create it and make it writable, or point RUNTIME_CONFIG_DIR somewhere else.`,
  );
  process.exit(1);
}

// A system restore staged by a restore job goes in place before the database is opened:
// this is the one point where nothing holds it. Only when starting the server: a
// `--version` or `--doctor` run beside a running server must not swap files under it.
//
// A restore that cannot be applied stops the start. Running on with, say, the restored
// config.toml beside the old database would mix two points in time; the staging is kept,
// so the next start tries again once the cause is fixed.
if (parseCli().type === "serve") {
  try {
    const applied = applyPendingRestore(envConfig.RUNTIME_CONFIG_DIR);
    if (applied.length > 0) console.log(`♻️  Restored from backup: ${applied.join(", ")}`);
  } catch (err) {
    console.error(
      `❌ Could not apply the staged restore: ${err instanceof Error ? err.message : String(err)}\n` +
      `   Fix the cause and start again. ${abandonInstructions(envConfig.RUNTIME_CONFIG_DIR)}`,
    );
    process.exit(1);
  }
}

const sqlite = new Database(databasePath);
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

/**
 * Write a consistent copy of the database to `path`, which must not exist.
 *
 * `VACUUM INTO` reads in one transaction, so the copy is a single moment of the database
 * even while requests write to it, and it carries no write-ahead log of its own. Copying
 * the file instead could catch it between a write and its checkpoint.
 */
export function snapshotDatabase(path: string): void {
  sqlite.run("VACUUM INTO ?", [path]);
}
