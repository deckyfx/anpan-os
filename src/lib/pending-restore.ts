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

/**
 * Put a staged system restore in place. Returns the entries applied; none when nothing is
 * staged or the staging is incomplete. Throws when an entry cannot be put in place; the
 * staging is then kept, so the next start tries again.
 *
 * No entry is ever missing at a moment the process could stop: each live entry is moved
 * aside (not deleted), its replacement renamed in, and only then the aside copy removed.
 * A start that stops half way finds the entries not yet applied still staged and applies
 * them; the marker goes last.
 */
export function applyPendingRestore(runtimeDir: string): string[] {
  const staged = join(runtimeDir, PENDING_DIR);
  if (!existsSync(join(staged, READY_MARKER))) return [];

  const applied: string[] = [];
  for (const entry of SYSTEM_ENTRIES) {
    const from = join(staged, entry);
    if (!existsSync(from)) continue;
    const to = join(runtimeDir, entry);
    // The database's write-ahead log and shared memory belong to the file being replaced:
    // left beside the restored one, SQLite would replay the old log into it. They move
    // aside with it.
    const group = entry === "storage.db" ? [to, `${to}-wal`, `${to}-shm`] : [to];
    for (const path of group) {
      rmSync(path + ASIDE, { recursive: true, force: true }); // left by an earlier attempt
      if (existsSync(path)) renameSync(path, path + ASIDE);
    }
    renameSync(from, to);
    for (const path of group) rmSync(path + ASIDE, { recursive: true, force: true });
    applied.push(entry);
  }
  rmSync(staged, { recursive: true, force: true });
  return applied;
}

/** Whether a system restore is staged and waiting for a restart. */
export function restorePending(runtimeDir: string): boolean {
  return existsSync(join(runtimeDir, PENDING_DIR, READY_MARKER));
}
