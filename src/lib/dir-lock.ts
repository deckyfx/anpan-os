import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A lock shared between processes, held by creating a directory.
 *
 * mkdir is the lock: it is atomic on every platform this runs on, unlike a check-then-create
 * on a file. The owner records an identity inside so a lock whose owner died can be
 * reclaimed instead of blocking every later caller forever.
 *
 * Extracted from the migration manager, where each rule below was added after a review found
 * the version without it unsafe, so that the self-updater does not need a second, weaker copy.
 * The rules, in brief:
 *  - the owner is identified by PID *and* process start time, since a PID can be reused;
 *  - a lock with no owner recorded yet is being published, not abandoned, for a grace period;
 *  - a live owner is never reclaimed on age alone, only one whose identity cannot be checked;
 *  - reclaiming is itself serialised by a second lock, or two waiters could each delete the
 *    other's fresh lock;
 *  - the owner refreshes its token while it works, and only ever refreshes or releases a lock
 *    still recorded as its own.
 */

/** Thrown by {@link DirLock.run} when the lock stays held past the caller's wait. */
export class LockBusyError extends Error {
  constructor(readonly lockDir: string) {
    super(`Lock is held: ${lockDir}`);
  }
}

export interface DirLockOptions {
  /** The directory whose creation takes the lock. */
  lockDir: string;
  /** The directory that serialises reclaiming an abandoned lock. */
  reclaimDir: string;
  /** How long to wait for a held lock before giving up with LockBusyError. 0 refuses at once. */
  waitMs: number;
  /** A lock whose owner cannot be identified is presumed abandoned after this long. */
  staleMs?: number;
  /** Called when an abandoned lock is reclaimed, for the caller's own log line. */
  onReclaim?: () => void;
}

/** How long a lock with no owner recorded yet is presumed mid-publish rather than abandoned. */
const PUBLISH_GRACE_MS = 15_000;

/**
 * Staleness bound for the reclaim mutex. Far shorter than the lock's own, since it is held
 * across a few filesystem calls and never across real work, so anything older is a crashed
 * reclaimer rather than a slow one.
 */
const RECLAIM_STALE_MS = 30_000;

/** How often a waiting caller retries. */
const RETRY_MS = 250;

export class DirLock {
  private readonly lockDir: string;
  private readonly reclaimDir: string;
  private readonly waitMs: number;
  private readonly staleMs: number;
  private readonly onReclaim?: () => void;

  constructor(options: DirLockOptions) {
    this.lockDir    = options.lockDir;
    this.reclaimDir = options.reclaimDir;
    this.waitMs     = options.waitMs;
    this.staleMs    = options.staleMs ?? 5 * 60_000;
    this.onReclaim  = options.onReclaim;
  }

  /** Run `fn` holding the lock. Throws LockBusyError if it stays held past `waitMs`. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const deadline = Date.now() + this.waitMs;

    for (;;) {
      try {
        mkdirSync(this.lockDir); // throws if it already exists
        writeFileSync(join(this.lockDir, "pid"), ownerToken());
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;

        // Retry at once only when a reclaim actually removed the lock. Otherwise fall through
        // to the deadline: reclaim() does nothing when another process holds the reclaim
        // mutex or the lock turned out to be live, and retrying then would spin hot and never
        // time out. And retry before the deadline check, not after it -- with no wait, a
        // caller that cleared a dead owner's lock would otherwise give up anyway, leaving the
        // lock it just freed to whoever asks next.
        if (this.isAbandoned() && this.reclaim()) continue;

        if (Date.now() >= deadline) throw new LockBusyError(this.lockDir);
        await Bun.sleep(RETRY_MS);
      }
    }

    const pidFile = join(this.lockDir, "pid");
    const token = ownerToken();

    // Deliberately synchronous I/O here and in the release below, against the usual
    // preference for Bun.file/Bun.write: the ownership check and the write that follows it
    // must not be separated by an await. An async heartbeat can also overlap itself, and
    // the release runs in a finally block where an await point risks the process exiting
    // between deciding the lock is ours and removing it.
    //
    // Refresh the token while the work runs. The age check measures time since
    // acquisition, so work slower than staleMs would otherwise look abandoned: another
    // process would reclaim the lock mid-run, and the original would then delete *its*
    // lock on the way out — losing mutual exclusion in exactly the slow case.
    const heartbeat: Timer = setInterval(() => {
      try {
        // Refresh only a lock still recorded as ours. Writing unconditionally would let a
        // displaced owner stamp its token over the current one, and the real holder would
        // then fail its own release check while we deleted a lock we no longer hold.
        if (readFileSync(pidFile, "utf8").trim() !== token) {
          clearInterval(heartbeat);
          return;
        }
        writeFileSync(pidFile, token);
      } catch {
        /* reclaimed or removed — the ownership check below handles it */
      }
    }, Math.floor(this.staleMs / 4));

    try {
      return await fn();
    } finally {
      clearInterval(heartbeat);
      // Release only a lock still recorded as ours. If it was reclaimed despite the
      // heartbeat, removing it here would evict whoever holds it now.
      let stillOurs = false;
      try { stillOurs = readFileSync(pidFile, "utf8").trim() === token; } catch { /* gone */ }
      if (stillOurs) rmSync(this.lockDir, { recursive: true, force: true });
    }
  }

  /**
   * Remove an abandoned lock, serialised so no waiter can delete another's live lock.
   *
   * The abandonment test is re-run while holding the mutex, because the observation that
   * sent us here was made outside it and the lock may since have been replaced by a live
   * owner. A waiter on the fast path can still win the mkdir after the delete; that is a
   * correct outcome — exactly one owner either way.
   *
   * Returns whether the lock is now free to try for: true when it was removed, here or by
   * another reclaimer; false when it was left alone.
   */
  private reclaim(): boolean {
    try {
      mkdirSync(this.reclaimDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      // Another process is reclaiming. Let it finish; only clear a mutex left by a crash.
      try {
        if (Date.now() - statSync(this.reclaimDir).mtimeMs > RECLAIM_STALE_MS) {
          rmSync(this.reclaimDir, { recursive: true, force: true });
        }
      } catch { /* vanished under us — nothing to clear */ }
      return false;
    }

    try {
      // Already gone — another reclaimer got here first. Without this, isAbandoned()
      // reports a missing directory as abandoned and we report reclaiming nothing.
      // Gone already: another reclaimer removed it, which frees it for us just the same.
      try { statSync(this.lockDir); } catch { return true; }
      if (!this.isAbandoned()) return false;   // replaced by a live owner since we looked
      this.onReclaim?.();
      rmSync(this.lockDir, { recursive: true, force: true });
      return true;
    } finally {
      rmSync(this.reclaimDir, { recursive: true, force: true });
    }
  }

  /**
   * True when the lock's owner is gone.
   *
   * A live owner is never reclaimed on age alone: its heartbeat can be delayed by
   * synchronous work, and reclaiming on that basis would evict a process still working.
   * Age decides only where ownership genuinely cannot be established.
   */
  private isAbandoned(): boolean {
    let raw: string;
    try {
      raw = readFileSync(join(this.lockDir, "pid"), "utf8").trim();
    } catch {
      // Being published right now, or left behind empty. Only the second is reclaimable,
      // and only once the publish window has passed.
      return this.olderThan(PUBLISH_GRACE_MS);
    }

    const [pidPart, startPart] = raw.split(":");
    const pid = Number.parseInt(pidPart ?? "", 10);
    if (!Number.isFinite(pid) || pid <= 0) return this.olderThan(this.staleMs);

    let alive = true;
    try { process.kill(pid, 0); } catch { alive = false; }
    if (!alive) return true;                       // owner is gone: reclaimable

    const recordedStart = startPart && startPart !== "?" ? startPart : null;
    const currentStart  = startTimeOf(pid);

    // Same PID and same start time: definitively the live owner. Never reclaim, however
    // old the token looks.
    if (recordedStart && currentStart) return recordedStart !== currentStart;

    // Start times unavailable, so a recycled PID cannot be ruled out. Age decides.
    return this.olderThan(this.staleMs);
  }

  /**
   * Whether the lock was last touched longer ago than `ms`.
   *
   * Uses statSync rather than Bun.file().lastModified: the latter does not throw for a
   * missing file, and the value it returns makes every comparison here false, which turned
   * an abandoned empty lock into one that could never be reclaimed.
   */
  private olderThan(ms: number): boolean {
    // Token file if it exists (the heartbeat keeps it fresh), else the directory itself.
    for (const path of [join(this.lockDir, "pid"), this.lockDir]) {
      try {
        return Date.now() - statSync(path).mtimeMs > ms;
      } catch {
        continue;
      }
    }
    return true;                                   // lock vanished from under us
  }
}

/**
 * Identify the lock owner as more than a PID.
 *
 * A PID alone is ambiguous: the owner can die and the number be reused, after which a
 * liveness check reports "held" forever. Linux exposes a process start time in field 22 of
 * /proc/<pid>/stat, and the pair is unique for as long as the machine is up.
 */
function ownerToken(): string {
  return `${process.pid}:${startTimeOf(process.pid) ?? "?"}`;
}

/** Process start time in clock ticks, or null where /proc is unavailable. */
function startTimeOf(pid: number): string | null {
  try {
    // comm can contain spaces and parentheses, so parse after the last ')'.
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null;
  } catch {
    return null;
  }
}
