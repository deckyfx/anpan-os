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

/**
 * Put a staged system restore in place. Returns the entries applied; none when nothing is
 * staged or the staging is incomplete.
 *
 * Each entry replaces the live one by rename, so the swap of each is all or nothing. The
 * marker goes last: a start interrupted half way applies the remaining entries next time.
 */
export function applyPendingRestore(runtimeDir: string): string[] {
  const staged = join(runtimeDir, PENDING_DIR);
  if (!existsSync(join(staged, READY_MARKER))) return [];

  const applied: string[] = [];
  for (const entry of SYSTEM_ENTRIES) {
    const from = join(staged, entry);
    if (!existsSync(from)) continue;
    const to = join(runtimeDir, entry);
    if (entry === "storage.db") {
      // The live database's write-ahead log belongs to the file being replaced. Left beside
      // the restored one, SQLite would replay it into it.
      rmSync(`${to}-wal`, { force: true });
      rmSync(`${to}-shm`, { force: true });
    }
    rmSync(to, { recursive: true, force: true });
    renameSync(from, to);
    applied.push(entry);
  }
  rmSync(staged, { recursive: true, force: true });
  return applied;
}

/** Whether a system restore is staged and waiting for a restart. */
export function restorePending(runtimeDir: string): boolean {
  return existsSync(join(runtimeDir, PENDING_DIR, READY_MARKER));
}
