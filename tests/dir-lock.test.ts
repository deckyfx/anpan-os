import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DirLock, LockBusyError } from "../src/lib/dir-lock";

/**
 * The lock shared by database migrations and self-updates. Each rule it follows was added
 * after a review showed the version without it unsafe; these pin them down directly. The
 * migration path is also exercised end to end on a compiled binary.
 */

const root = mkdtempSync(join(tmpdir(), "anpan-dirlock-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let n = 0;
let lockDir = "";
let reclaimDir = "";
beforeEach(() => {
  n++;
  lockDir = join(root, `lock-${n}`);
  reclaimDir = join(root, `reclaim-${n}`);
});

const lock = (waitMs = 0, onReclaim?: () => void) => new DirLock({ lockDir, reclaimDir, waitMs, onReclaim });

/** Plant a lock as if another process held it. */
function plant(token: string | null, ageMs = 0) {
  mkdirSync(lockDir);
  if (token !== null) writeFileSync(join(lockDir, "pid"), token);
  const when = new Date(Date.now() - ageMs);
  if (token !== null) utimesSync(join(lockDir, "pid"), when, when);
  utimesSync(lockDir, when, when);
}

/** This process's identity as the lock records it: PID and, where /proc exists, start time. */
const hasProc = existsSync("/proc/self/stat");
function ownToken(): string {
  if (!hasProc) return `${process.pid}:?`;
  const stat = readFileSync(`/proc/${process.pid}/stat`, "utf8");
  return `${process.pid}:${stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]}`;
}

describe("DirLock", () => {
  test("one holder at a time: a second caller is refused while the first works", async () => {
    let release!: () => void;
    const held = new Promise<void>(r => { release = r; });
    const first = lock().run(() => held);
    await Bun.sleep(20);
    await expect(lock().run(async () => "second")).rejects.toBeInstanceOf(LockBusyError);
    release();
    await first;
  });

  test("a waiting caller gets the lock once it is released", async () => {
    const first = lock().run(() => Bun.sleep(300));
    await Bun.sleep(20);
    expect(await lock(3000).run(async () => "second")).toBe("second");
    await first;
  });

  test("the lock is released after the work, and after work that throws", async () => {
    await lock().run(async () => {});
    expect(existsSync(lockDir)).toBe(false);
    await expect(lock().run(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(existsSync(lockDir)).toBe(false);
  });

  test("a lock whose owner has died is reclaimed", async () => {
    plant("999999:123");
    let reclaimed = false;
    expect(await lock(0, () => { reclaimed = true; }).run(async () => "ran")).toBe("ran");
    expect(reclaimed).toBe(true);
  });

  test("a live owner is not reclaimed", async () => {
    plant(ownToken());
    await expect(lock().run(async () => {})).rejects.toBeInstanceOf(LockBusyError);
  });

  test.skipIf(!hasProc)("a live owner is not reclaimed however old its token looks", async () => {
    // Work can starve the heartbeat; reclaiming a live owner on age would evict it mid-work.
    plant(ownToken(), 60 * 60_000);
    await expect(lock().run(async () => {})).rejects.toBeInstanceOf(LockBusyError);
  });

  test.skipIf(!hasProc)("a recycled PID — same number, different start time — is reclaimed", async () => {
    plant(`${process.pid}:1`);
    expect(await lock().run(async () => "ran")).toBe("ran");
  });

  test("a lock with no owner recorded yet is being published, not abandoned", async () => {
    plant(null);
    await expect(lock().run(async () => {})).rejects.toBeInstanceOf(LockBusyError);
  });

  test("a lock left empty past the publish window is reclaimed", async () => {
    plant(null, 60_000);
    expect(await lock().run(async () => "ran")).toBe("ran");
  });

  test("a reclaim mutex left by a crashed reclaimer is cleared", async () => {
    plant("999999:123");
    mkdirSync(reclaimDir);
    const old = new Date(Date.now() - 60_000);
    utimesSync(reclaimDir, old, old);
    // The first attempt clears the stale mutex; a short wait lets the next one reclaim.
    expect(await lock(2000).run(async () => "ran")).toBe("ran");
    expect(existsSync(reclaimDir)).toBe(false);
  });
});
