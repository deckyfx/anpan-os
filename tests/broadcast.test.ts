import { test, expect, describe } from "bun:test";
import { Broadcast } from "../src/lib/broadcast";

/** Collect up to `n` messages, then stop iterating. */
async function take<T>(gen: AsyncGenerator<T>, n: number): Promise<T[]> {
  const out: T[] = [];
  if (n === 0) return out;
  for await (const m of gen) {
    out.push(m);
    if (out.length >= n) break;
  }
  return out;
}

describe("Broadcast", () => {
  test("every subscriber receives every message, unlike a single-consumer queue", async () => {
    const bus = new Broadcast<number>();
    const a = take(bus.subscribe(), 3);
    const b = take(bus.subscribe(), 3);
    await Promise.resolve();

    bus.publish(1); bus.publish(2); bus.publish(3);

    // The point of this class: two dashboard tabs must not split the stream between them.
    expect(await a).toEqual([1, 2, 3]);
    expect(await b).toEqual([1, 2, 3]);
  });

  test("publish never blocks on a subscriber that stopped reading", async () => {
    const bus = new Broadcast<number>();
    void bus.subscribe();          // attaches, never iterates
    await Promise.resolve();

    // 2000 exceeds the per-subscriber queue cap; this must still return promptly.
    const started = Date.now();
    for (let i = 0; i < 2000; i++) bus.publish(i);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test("a subscriber that unsubscribes is removed", async () => {
    const bus = new Broadcast<number>();
    const gen = bus.subscribe();
    const collected = take(gen, 1);
    await Promise.resolve();

    bus.publish(1);
    await collected;
    // `take` breaks out of the loop, which returns the generator and runs its finally.
    await new Promise(r => setTimeout(r, 10));
    expect(bus.size).toBe(0);
  });

  test("an aborted signal ends iteration", async () => {
    const bus = new Broadcast<number>();
    const ac = new AbortController();
    const collected = (async () => {
      const out: number[] = [];
      for await (const m of bus.subscribe(ac.signal)) out.push(m);
      return out;
    })();
    await Promise.resolve();

    bus.publish(1);
    await new Promise(r => setTimeout(r, 5));
    ac.abort();

    expect(await collected).toEqual([1]);
  });

  test("closeAll ends every subscriber", async () => {
    const bus = new Broadcast<number>();
    const a = (async () => { const o: number[] = []; for await (const m of bus.subscribe()) o.push(m); return o; })();
    const b = (async () => { const o: number[] = []; for await (const m of bus.subscribe()) o.push(m); return o; })();
    await Promise.resolve();

    bus.publish(7);
    await new Promise(r => setTimeout(r, 5));
    bus.closeAll();

    expect(await a).toEqual([7]);
    expect(await b).toEqual([7]);
    expect(bus.size).toBe(0);
  });
});
