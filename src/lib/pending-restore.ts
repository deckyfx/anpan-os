/**
 * A system restore, applied when the server next starts.
 *
 * Restoring the system part of a backup replaces the server's own files: config.toml and
 * the database it has open. Swapping them under the running process would leave it writing
 * to a database file that is no longer there, so a restore job only stages them, in
 * `<runtime dir>/restore-pending/`, and this puts them in place at the next start, before
 * the database is opened.
 *
 * The job writes {@link READY_MARKER} last. A folder without it is a staging that did not
 * finish, and is left alone rather than half applied.
 */
import { existsSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

/** The staging folder, under the runtime dir. */
export const PENDING_DIR = "restore-pending";

/** Written once everything is staged; its absence means "not ready". */
export const READY_MARKER = ".ready";

/**
 * What the system part of a backup holds, relative to the runtime dir. The rest of that
 * dir (stack folders, logs, backups themselves) is either in the app archives or not worth
 * keeping.
 */
export const SYSTEM_ENTRIES = ["config.toml", "storage.db", "samba.conf", "certs"] as const;

/** Suffix of a live entry moved aside while its replacement goes in. */
const ASIDE = ".pre-restore";

/** The live paths an entry stands for: the database brings its WAL and shared memory. */
function liveGroup(runtimeDir: string, entry: string): string[] {
  const to = join(runtimeDir, entry);
  // Left beside the restored database, SQLite would replay the old log into it.
  return entry === "storage.db" ? [to, `${to}-wal`, `${to}-shm`] : [to];
}

/**
 * Put a staged system restore in place, all or nothing. Returns the entries applied; none
 * when nothing is staged or the staging is incomplete.
 *
 * Every live entry is moved aside first, then every staged one renamed in, then the aside
 * copies removed. When a rename in fails, the entries already renamed go back to the
 * staging and the aside copies back in place, and this throws: the files are as they were
 * and the staging is still there, so the next start tries again (or the staging can be
 * deleted to start without it).
 *
 * A start that stops part way (power loss) leaves aside copies and a partly emptied
 * staging. The next start carries on from there: an aside copy already present is the
 * original and is kept as such, and an entry no longer staged was already put in place.
 */
export function applyPendingRestore(runtimeDir: string): string[] {
  const staged = join(runtimeDir, PENDING_DIR);
  if (!existsSync(join(staged, READY_MARKER))) return [];
  const plan = SYSTEM_ENTRIES.filter(entry => existsSync(join(staged, entry)));

  // 1. Move the live entries aside.
  for (const entry of plan) {
    for (const path of liveGroup(runtimeDir, entry)) {
      if (existsSync(path + ASIDE)) rmSync(path, { recursive: true, force: true }); // the original is already aside
      else if (existsSync(path)) renameSync(path, path + ASIDE);
    }
  }

  // 2. Rename the staged entries in; on a failure, undo this run.
  const done: string[] = [];
  try {
    for (const entry of plan) {
      renameSync(join(staged, entry), join(runtimeDir, entry));
      done.push(entry);
    }
  } catch (err) {
    for (const entry of done) renameSync(join(runtimeDir, entry), join(staged, entry));
    for (const entry of plan) {
      for (const path of liveGroup(runtimeDir, entry)) {
        if (!existsSync(path + ASIDE)) continue;
        rmSync(path, { recursive: true, force: true });
        renameSync(path + ASIDE, path);
      }
    }
    throw err;
  }

  // 3. Drop the aside copies (also any an interrupted earlier start left), then the staging.
  for (const entry of SYSTEM_ENTRIES) {
    for (const path of liveGroup(runtimeDir, entry)) rmSync(path + ASIDE, { recursive: true, force: true });
  }
  rmSync(staged, { recursive: true, force: true });
  return plan;
}

/** Whether a system restore is staged and waiting for a restart. */
export function restorePending(runtimeDir: string): boolean {
  return existsSync(join(runtimeDir, PENDING_DIR, READY_MARKER));
}
