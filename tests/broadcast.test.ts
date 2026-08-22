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
    const gen = bus.subscribe();
    // An async generator does not run its body until the first next(), so the subscriber
    // is not attached by subscribe() alone — the pull has to come first, and the publish
    // after it, or nothing about a full queue is being tested.
    const first = gen.next();
    await new Promise(r => setTimeout(r, 0));
    expect(bus.size).toBe(1);
    bus.publish(0);
    await first;

    // Beyond the per-subscriber cap: publish must stay prompt and shed the subscriber
    // rather than waiting for a consumer that has stopped reading.
    const started = Date.now();
    for (let i = 0; i < 2000; i++) bus.publish(i);
    expect(Date.now() - started).toBeLessThan(1000);

    // The over-full subscriber is closed, so its iteration ends rather than hanging.
    const rest: number[] = [];
    for await (const m of gen) rest.push(m);
    expect(rest.length).toBeLessThan(2000);
    expect(bus.size).toBe(0);
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

  test("an already-aborted signal ends the stream instead of parking forever", async () => {
    const bus = new Broadcast<number>();
    const ac = new AbortController();
    ac.abort();                       // aborted before anyone subscribes

    // addEventListener never fires for an already-aborted signal, so without an explicit
    // check the generator would wait on its wake promise indefinitely and the subscriber
    // would never be removed. A client that disconnects before the route attaches hits
    // this exact path.
    const out: number[] = [];
    const collected = (async () => {
      for await (const m of bus.subscribe(ac.signal)) out.push(m);
      return "ended";
    })();

    expect(await Promise.race([
      collected,
      new Promise(r => setTimeout(() => r("HUNG"), 500)),
    ])).toBe("ended");
    expect(bus.size).toBe(0);
  });

  test("attach() with an aborted signal leaves no subscriber behind", async () => {
    const bus = new Broadcast<number>();
    const ac = new AbortController();
    ac.abort();

    const sub = bus.attach(ac.signal);
    const drained = (async () => { for await (const _ of sub.events) { /* drain */ } })();
    await Promise.race([drained, new Promise(r => setTimeout(r, 500))]);
    expect(bus.size).toBe(0);
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
