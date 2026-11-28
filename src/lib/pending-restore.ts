/**
 * A system restore, applied when the server next starts.
 *
 * Restoring the system part of a backup replaces the server's own files: config.toml and
 * the database it has open. Swapping them under the running process would leave it writing
 * to a database file that is no longer there, so a restore job only stages them, in
 * `<runtime dir>/restore-pending/`, and this puts them in place at the next start, before
 * the database is opened.
 *
 * The staging folder is also the record of how far a start got:
 *
 *   restore-pending/
 *     .ready        the staging is complete (written last by the job)
 *     config.toml   …  entries still to put in place
 *     .originals/   the live entries they replace, moved here first
 *     .committed    every entry is in place; only clean-up is left
 *
 * So whatever stops a start (an error, a power cut), the originals are in one known place
 * until the restore has committed, and the next start can carry on or put them back.
 */
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The staging folder, under the runtime dir. */
export const PENDING_DIR = "restore-pending";

/** Written once everything is staged; its absence means "not ready". */
export const READY_MARKER = ".ready";

/** Where the live entries go while their replacements go in. */
const ORIGINALS = ".originals";

/** Written once every entry is in place. */
const COMMITTED = ".committed";

/** The staging folder a replacement is being moved into place over; see stageSystem. */
export const PREVIOUS_SUFFIX = ".previous";

/**
 * What the system part of a backup holds, relative to the runtime dir. The rest of that
 * dir (stack folders, logs, backups themselves) is either in the app archives or not worth
 * keeping.
 */
export const SYSTEM_ENTRIES = ["config.toml", "storage.db", "samba.conf", "certs"] as const;

/** The live paths an entry stands for: the database brings its WAL and shared memory. */
function liveGroup(entry: string): string[] {
  // Left beside the restored database, SQLite would replay the old log into it.
  return entry === "storage.db" ? [entry, `${entry}-wal`, `${entry}-shm`] : [entry];
}

/**
 * The ready staging folder, if there is one. Normally `restore-pending`; when a new
 * staging was being put in place over an older one and that was cut short, the older one,
 * moved aside as `restore-pending.previous`, is still the restore the user asked for.
 */
function readyStaging(runtimeDir: string): string | null {
  for (const dir of [join(runtimeDir, PENDING_DIR), join(runtimeDir, PENDING_DIR + PREVIOUS_SUFFIX)]) {
    if (existsSync(join(dir, READY_MARKER))) return dir;
  }
  return null;
}

/** The steps to start without the restore, for an operator reading the log. */
export function abandonInstructions(runtimeDir: string): string {
  const staged = readyStaging(runtimeDir) ?? join(runtimeDir, PENDING_DIR);
  return `To start without the restore: move everything in ${join(staged, ORIGINALS)} (if it exists) back into `
    + `${runtimeDir}, replacing what is there, then delete ${staged}.`;
}

/**
 * Put a staged system restore in place, all or nothing. Returns the entries applied; none
 * when nothing is staged or the staging is incomplete.
 *
 * Each live entry (the database with its WAL and SHM) moves into `.originals`, then each
 * staged entry renames into its place, then `.committed` is written and the staging
 * removed. When a step before the commit fails, the entries this start put in place move
 * back to the staging and the originals back into place, and this throws; whatever could
 * not be moved back stays where it is (an original leaves `.originals` only for a free
 * slot), so the staging still records it.
 *
 * A start cut short is carried on by the next one: an original already in `.originals`
 * stays the original, and an entry no longer staged is in place. After the commit, a
 * clean-up that fails is reported, never a reason to stop the start: the restore is in.
 */
export function applyPendingRestore(runtimeDir: string): string[] {
  const staged = readyStaging(runtimeDir);
  if (!staged) return [];
  const originals = join(staged, ORIGINALS);
  let applied: string[] = SYSTEM_ENTRIES.filter(e => existsSync(join(runtimeDir, e)));

  if (!existsSync(join(staged, COMMITTED))) {
    const plan = SYSTEM_ENTRIES.filter(entry => existsSync(join(staged, entry)));
    const renamedIn: string[] = [];
    try {
      mkdirSync(originals, { recursive: true });
      // 1. Move the live entries into .originals. One already there (an earlier start
      //    moved it) stays: it is the original, and what fills the slot now is not.
      for (const entry of plan) {
        for (const name of liveGroup(entry)) {
          const live = join(runtimeDir, name);
          if (existsSync(join(originals, name))) { rmSync(live, { recursive: true, force: true }); continue; }
          if (existsSync(live)) renameSync(live, join(originals, name));
        }
      }
      // 2. Rename the staged entries in.
      for (const entry of plan) {
        renameSync(join(staged, entry), join(runtimeDir, entry));
        renamedIn.push(entry);
      }
      // 3. Commit.
      writeFileSync(join(staged, COMMITTED), "");
    } catch (err) {
      undo(runtimeDir, staged, renamedIn);
      throw err;
    }
    applied = plan;
  }

  // Committed: clean-up only. A failure is reported and left for the next start.
  try {
    rmSync(staged, { recursive: true, force: true });
    rmSync(join(runtimeDir, PENDING_DIR + PREVIOUS_SUFFIX), { recursive: true, force: true });
  } catch (err) {
    console.error(`⚠️  The restore is in place, but ${staged} could not be removed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return applied;
}

/**
 * Undo a start that failed before its commit: the entries it put in place go back to the
 * staging, then each original back into its slot, but only into a slot that is free, and
 * the database with its WAL and SHM as one. A step that fails leaves both versions where
 * they are, reported for the operator.
 */
function undo(runtimeDir: string, staged: string, renamedIn: string[]): void {
  const left: string[] = [];
  for (const entry of renamedIn) {
    try { renameSync(join(runtimeDir, entry), join(staged, entry)); }
    catch (e) { left.push(`${entry} is in place but could not go back to ${staged}: ${(e as Error).message}`); }
  }
  const originals = join(staged, ORIGINALS);
  for (const entry of SYSTEM_ENTRIES) {
    // An entry and its companions go back together or not at all: the old database's WAL
    // beside the restored database would be replayed into it.
    if (!existsSync(join(originals, entry))) continue;
    const live = join(runtimeDir, entry);
    if (existsSync(live)) { left.push(`the original ${entry} is in ${originals}; ${live} holds the restored one`); continue; }
    for (const name of liveGroup(entry)) {
      const from = join(originals, name);
      if (!existsSync(from)) continue;
      try { renameSync(from, join(runtimeDir, name)); }
      catch (e) { left.push(`the original ${name} is in ${originals}: ${(e as Error).message}`); }
    }
  }
  if (left.length > 0) console.error(`   Could not undo everything:\n   - ${left.join("\n   - ")}`);
}

/** Whether a system restore is staged and waiting for a restart. */
export function restorePending(runtimeDir: string): boolean {
  return readyStaging(runtimeDir) !== null;
}
