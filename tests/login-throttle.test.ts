import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { eq } from "drizzle-orm";
import { createApp } from "../src/app";
import { db } from "../src/db/index";
import { users } from "../src/db/schema";
import { UserStore } from "../src/stores/user-store";
import { LoginThrottle } from "../src/lib/login-throttle";
import { TEST_JWT, extractCookie } from "./helpers";

/**
 * Nothing limited how fast passwords could be guessed. The schedule is tested on the class
 * with a fake clock; the routes are tested end to end, including that a *correct* password
 * is refused while a wait is in force — otherwise the wait would not slow a guesser at all.
 */

describe("LoginThrottle", () => {
  function clocked(options = {}) {
    let t = 1_000_000;
    const throttle = new LoginThrottle({ now: () => t, ...options });
    return { throttle, advance: (ms: number) => { t += ms; } };
  }

  test("the first failures are free, then each doubles the wait, up to the cap", () => {
    const { throttle } = clocked();
    const waits: number[] = [];
    for (let i = 0; i < 12; i++) { throttle.recordFailure("k"); waits.push(throttle.retryAfterMs("k")); }
    expect(waits).toEqual([0, 0, 0, 0, 0, 1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  });

  test("the wait runs down with time", () => {
    const { throttle, advance } = clocked({ freeFailures: 0 });
    throttle.recordFailure("k");
    expect(throttle.retryAfterMs("k")).toBe(1000);
    advance(600);
    expect(throttle.retryAfterMs("k")).toBe(400);
    advance(400);
    expect(throttle.retryAfterMs("k")).toBe(0);
  });

  test("a success clears the key, and keys do not affect each other", () => {
    const { throttle } = clocked({ freeFailures: 0 });
    throttle.recordFailure("a");
    throttle.recordFailure("b");
    throttle.recordSuccess("a");
    expect(throttle.retryAfterMs("a")).toBe(0);
    expect(throttle.retryAfterMs("b")).toBeGreaterThan(0);
  });

  test("a key that goes quiet long enough starts over", () => {
    const { throttle, advance } = clocked({ freeFailures: 0, forgetAfterMs: 60_000 });
    for (let i = 0; i < 4; i++) throttle.recordFailure("k");
    advance(61_000);
    throttle.recordFailure("k");                       // counts as the first failure again
    expect(throttle.retryAfterMs("k")).toBe(1000);
  });

  test("acquire reserves a key: a second attempt waits until the first is decided", () => {
    const { throttle } = clocked();
    expect(throttle.acquire("k")).toBe(0);
    expect(throttle.acquire("k")).toBeGreaterThan(0);   // one is being verified
    expect(throttle.acquire("other")).toBe(0);          // other keys are unaffected
    throttle.release("k");
    expect(throttle.acquire("k")).toBe(0);
  });

  test("acquire refuses while a delay is in force", () => {
    const { throttle } = clocked({ freeFailures: 0 });
    throttle.recordFailure("k");
    expect(throttle.acquire("k")).toBe(1000);
  });

  test("the table is bounded: the oldest key is dropped beyond capacity", () => {
    const { throttle } = clocked({ freeFailures: 0, capacity: 3 });
    for (const k of ["a", "b", "c", "d"]) throttle.recordFailure(k);
    expect(throttle.size).toBe(3);
    expect(throttle.retryAfterMs("a")).toBe(0);         // evicted
    expect(throttle.retryAfterMs("d")).toBeGreaterThan(0);
  });
});

describe("sign-in and password change routes", () => {
  const app = createApp(TEST_JWT);
  const username = `throttle-${crypto.randomUUID().slice(0, 8)}`;
  const password = "right-password-1";

  beforeAll(async () => { await UserStore.create(username, password); });
  afterAll(async () => { await db.delete(users).where(eq(users.username, username)); });

  const login = (pw: string) => app.handle(new Request("http://localhost/api/auth/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password: pw }),
  }));

  test("after the free failures, even the right password waits — then works, and resets", async () => {
    for (let i = 0; i < 6; i++) expect((await login("wrong-guess-1")).status).toBe(401);

    const held = await login(password);
    expect(held.status).toBe(429);
    expect(Number(held.headers.get("retry-after"))).toBeGreaterThan(0);

    await Bun.sleep(1100);                             // the sixth failure set a one-second wait
    expect((await login(password)).status).toBe(200);
    expect((await login("wrong-guess-1")).status).toBe(401);   // history cleared: not 429
  });

  test("guessing the current password through a password change is limited too", async () => {
    const cookie = extractCookie(await login(password)).cookie;
    const change = (current: string) => app.handle(new Request("http://localhost/api/auth/password", {
      method: "PUT", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ currentPassword: current, newPassword: "never-applied-9" }),
    }));
    for (let i = 0; i < 6; i++) expect((await change("wrong-guess-2")).status).toBe(400);
    expect((await change(password)).status).toBe(429);
  });

  test("one session's wrong guesses do not block another session's password change", async () => {
    // A thief holding a stolen session must not be able to keep the owner from changing the
    // password -- which is what ends the thief's session.
    const signIn = async () => extractCookie(await login(password)).cookie;
    const change = (cookie: string, current: string, next: string) =>
      app.handle(new Request("http://localhost/api/auth/password", {
        method: "PUT", headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ currentPassword: current, newPassword: next }),
      }));
    const thief = await signIn();
    const owner = await signIn();

    for (let i = 0; i < 6; i++) expect((await change(thief, "wrong-guess-3", "never-applied-9")).status).toBe(400);
    expect((await change(thief, password, "never-applied-9")).status).toBe(429);    // the thief waits

    expect((await change(owner, password, "owner-chose-this-1")).status).toBe(200);  // the owner does not
  });
});

describe("a burst of concurrent wrong passwords", () => {
  const app = createApp(TEST_JWT);
  const username = `burst-${crypto.randomUUID().slice(0, 8)}`;
  beforeAll(async () => { await UserStore.create(username, "the-real-one-1"); });
  afterAll(async () => { await db.delete(users).where(eq(users.username, username)); });

  test("is tested one guess at a time, not all at once", async () => {
    // Checking the delay before the (deliberately slow) verification and recording failures
    // after it let every request sent together through: twenty guesses, twenty verified,
    // before the first failure was recorded. With the key reserved, one is verified and the
    // rest are told to wait.
    const attempt = (i: number) => app.handle(new Request("http://localhost/api/auth/login", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password: `guess-number-${i}` }),
    }));
    const statuses = (await Promise.all(Array.from({ length: 20 }, (_, i) => attempt(i)))).map(r => r.status);
    expect(statuses.filter(s => s === 401)).toHaveLength(1);
    expect(statuses.filter(s => s === 429)).toHaveLength(19);
  });
});
