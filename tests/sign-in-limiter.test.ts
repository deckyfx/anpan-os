import { test, expect, describe } from "bun:test";
import { SignInLimiter, type SignInStart } from "../src/lib/sign-in-limiter";

/**
 * Each budget closes a way around the others. These drive the limiter with explicit source
 * addresses — which in-process requests cannot have — so the distributed cases can be tested:
 * guesses spread across many addresses must still meet a limit at the account.
 */

function clocked() {
  let t = 1_000_000;
  return { limiter: new SignInLimiter({ now: () => t }), advance: (ms: number) => { t += ms; } };
}

/** Start and immediately settle an attempt as wrong; returns whether it was let through. */
function failOnce(limiter: SignInLimiter, address: string, username: string): boolean {
  const start = limiter.begin(address, username);
  if ("waitMs" in start) return false;
  limiter.fail(start.ticket);
  limiter.end(start.ticket);
  return true;
}

const waits = (start: SignInStart) => "waitMs" in start;

describe("SignInLimiter", () => {
  test("guesses spread across many addresses still meet a limit at the account", () => {
    // One failure from each of 51 addresses: no single address ever comes near its own limit,
    // but the account has now seen 51 failures, past its 50 free.
    const { limiter } = clocked();
    for (let i = 0; i < 51; i++) expect(failOnce(limiter, `198.51.100.${i}`, "admin")).toBe(true);
    expect(waits(limiter.begin("203.0.113.9", "admin"))).toBe(true);   // a fresh address waits
    expect(waits(limiter.begin("203.0.113.9", "someone-else"))).toBe(false);
  });

  test("one guess at a time per account, whatever the address", () => {
    // A botnet's concurrent burst would otherwise all be verified before any failure landed.
    const { limiter } = clocked();
    const first = limiter.begin("198.51.100.1", "admin");
    expect(waits(first)).toBe(false);
    expect(waits(limiter.begin("198.51.100.2", "admin"))).toBe(true);
    if (!("waitMs" in first)) limiter.end(first.ticket);
    expect(waits(limiter.begin("198.51.100.2", "admin"))).toBe(false);
  });

  test("a start refused at the account does not keep its address reserved", () => {
    // The address is reserved first; if the account then refuses, the address must be given
    // back, or that address could not sign in to anything else until restart.
    const { limiter } = clocked();
    const held = limiter.begin("198.51.100.1", "admin");
    expect(waits(limiter.begin("198.51.100.2", "admin"))).toBe(true);        // refused at the account
    expect(waits(limiter.begin("198.51.100.2", "someone-else"))).toBe(false);  // address still free
    if (!("waitMs" in held)) limiter.end(held.ticket);
  });

  test("username churn from one address meets the address limit", () => {
    const { limiter } = clocked();
    for (let i = 0; i < 21; i++) expect(failOnce(limiter, "198.51.100.7", `throwaway-${i}`)).toBe(true);
    expect(waits(limiter.begin("198.51.100.7", "admin"))).toBe(true);
    expect(waits(limiter.begin("198.51.100.8", "admin"))).toBe(false);       // other addresses unaffected
  });

  test("a person's own typos never reach the account limit, and a success clears it all", () => {
    const { limiter, advance } = clocked();
    for (let i = 0; i < 5; i++) expect(failOnce(limiter, "192.168.0.10", "admin")).toBe(true);
    const probe = limiter.begin("192.168.0.10", "admin");
    expect(waits(probe)).toBe(false);
    if (!("waitMs" in probe)) limiter.end(probe.ticket);      // a probe must not keep its reservation
    // Twenty more, each after its delay has passed: 25 in all, still short of the account's 50.
    for (let i = 0; i < 20; i++) { expect(failOnce(limiter, "192.168.0.10", "admin")).toBe(true); advance(31_000); }

    const ok = limiter.begin("192.168.0.10", "admin");
    expect(waits(ok)).toBe(false);
    if (!("waitMs" in ok)) { limiter.succeed(ok.ticket); limiter.end(ok.ticket); }
    for (let i = 0; i < 5; i++) expect(failOnce(limiter, "192.168.0.10", "admin")).toBe(true);
  });
});
