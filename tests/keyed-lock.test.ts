import { test, expect, describe } from "bun:test";
import { KeyedLock } from "../src/lib/keyed-lock";

/**
 * The upload route relies on four properties: callers with one key never overlap, they run
 * in arrival order, a failing holder still releases, and other keys are never held up.
 * The map must also empty, or every upload id ever seen would stay in memory.
 */

/** A promise plus the function that resolves it, so a test can hold a lock open. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>(resolve => { open = resolve; });
  return { open, opened };
}

describe("KeyedLock", () => {
  test("callers sharing a key run one at a time, in arrival order", async () => {
    const lock = new KeyedLock();
    const events: string[] = [];
    const g = gate();

    const a = lock.run("k", async () => { events.push("a:start"); await g.opened; events.push("a:end"); });
    const b = lock.run("k", async () => { events.push("b:start"); events.push("b:end"); });
    const c = lock.run("k", async () => { events.push("c:start"); events.push("c:end"); });

    await Bun.sleep(10);
    expect(events).toEqual(["a:start"]);                 // b and c are waiting

    g.open();
    await Promise.all([a, b, c]);
    expect(events).toEqual(["a:start", "a:end", "b:start", "b:end", "c:start", "c:end"]);
  });

  test("different keys do not wait for each other", async () => {
    const lock = new KeyedLock();
    const g = gate();
    const held = lock.run("upload-1", () => g.opened);

    let otherRan = false;
    await lock.run("upload-2", async () => { otherRan = true; });
    expect(otherRan).toBe(true);                          // finished while upload-1 is held

    g.open();
    await held;
  });

  test("a holder that throws still releases the key", async () => {
    const lock = new KeyedLock();
    await expect(lock.run("k", async () => { throw new Error("disk full"); })).rejects.toThrow("disk full");

    let ran = false;
    await lock.run("k", async () => { ran = true; });
    expect(ran).toBe(true);
  });

  test("the result of the work is returned to its caller", async () => {
    const lock = new KeyedLock();
    expect(await lock.run("k", async () => 42)).toBe(42);
  });

  test("keys are dropped once nothing is running or queued", async () => {
    const lock = new KeyedLock();
    const g = gate();
    const a = lock.run("k", () => g.opened);
    const b = lock.run("k", async () => {});
    expect(lock.size).toBe(1);

    g.open();
    await Promise.all([a, b]);
    expect(lock.size).toBe(0);
  });
});
