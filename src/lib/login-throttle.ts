/**
 * Slows down repeated failed sign-ins for the same key.
 *
 * A few failures are free, since people mistype passwords. After that each further failure
 * makes the next attempt wait twice as long, up to a cap: 1 s, 2 s, 4 s … 30 s. Growing delays
 * rather than a lockout, because a lockout keyed on a username hands anyone who knows that
 * username a way to keep its owner out. At the cap, guessing runs at two attempts a minute.
 *
 * A key is forgotten once it has gone quiet for long enough, and the table is bounded, so an
 * attacker cycling through keys costs memory only up to that bound.
 *
 * A check is only as good as its timing. Password verification is deliberately slow, so a
 * check made before it and a failure recorded after it leave a window: requests sent at once
 * all pass the check, and every guess among them is tested before the first failure lands.
 * {@link acquire} therefore reserves the key for the length of the verification, and a second
 * attempt on the same key is refused while one is in flight.
 */

/** How long a caller is told to wait while another attempt on its key is being verified. */
const IN_FLIGHT_RETRY_MS = 1000;

export interface LoginThrottleOptions {
  /** Failures allowed before any delay applies. */
  freeFailures?: number;
  /** The longest an attempt is ever made to wait. */
  maxDelayMs?: number;
  /** A key with no failure for this long starts over. */
  forgetAfterMs?: number;
  /** Most keys held at once; the oldest is dropped beyond it. */
  capacity?: number;
  /** Clock, injectable for tests. */
  now?: () => number;
}

interface Entry {
  failures: number;
  lastFailureAt: number;
  nextAllowedAt: number;
}

export class LoginThrottle {
  private readonly entries = new Map<string, Entry>();
  /** Keys with a verification in progress. At most one attempt per key is tested at a time. */
  private readonly inFlight = new Set<string>();
  private readonly freeFailures: number;
  private readonly maxDelayMs: number;
  private readonly forgetAfterMs: number;
  private readonly capacity: number;
  private readonly now: () => number;

  constructor(options: LoginThrottleOptions = {}) {
    this.freeFailures  = options.freeFailures  ?? 5;
    this.maxDelayMs    = options.maxDelayMs    ?? 30_000;
    this.forgetAfterMs = options.forgetAfterMs ?? 15 * 60_000;
    this.capacity      = options.capacity      ?? 10_000;
    this.now           = options.now           ?? Date.now;
  }

  /** Milliseconds `key` must still wait before its next attempt; 0 when it may go ahead. */
  retryAfterMs(key: string): number {
    const entry = this.live(key);
    return entry ? Math.max(0, entry.nextAllowedAt - this.now()) : 0;
  }

  /**
   * Reserve `key` for one attempt. Returns 0 when reserved — the caller must then call
   * {@link release} when the attempt is decided — or the milliseconds to wait otherwise:
   * while a delay is in force, or while another attempt on the key is being verified.
   */
  acquire(key: string): number {
    const wait = this.retryAfterMs(key);
    if (wait > 0) return wait;
    if (this.inFlight.has(key)) return IN_FLIGHT_RETRY_MS;
    this.inFlight.add(key);
    return 0;
  }

  /** Release a key reserved by {@link acquire}. Call it however the attempt ended. */
  release(key: string): void {
    this.inFlight.delete(key);
  }

  /** Record a failed attempt, lengthening the wait once the free failures are used up. */
  recordFailure(key: string): void {
    const now = this.now();
    const failures = (this.live(key)?.failures ?? 0) + 1;
    const over = failures - this.freeFailures;
    const delay = over > 0 ? Math.min(1000 * 2 ** (over - 1), this.maxDelayMs) : 0;

    // Re-insert so the map's order tracks recency, which is what eviction relies on.
    this.entries.delete(key);
    if (this.entries.size >= this.capacity) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, { failures, lastFailureAt: now, nextAllowedAt: now + delay });
  }

  /** A successful attempt clears the key's history. */
  recordSuccess(key: string): void {
    this.entries.delete(key);
  }

  /** Number of keys currently held. */
  get size(): number {
    return this.entries.size;
  }

  /** The key's entry, dropping it first if it has gone quiet long enough to be forgotten. */
  private live(key: string): Entry | undefined {
    const entry = this.entries.get(key);
    if (entry && this.now() - entry.lastFailureAt > this.forgetAfterMs) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }
}
