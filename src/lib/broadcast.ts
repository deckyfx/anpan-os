/**
 * Multi-subscriber event fan-out for SSE.
 *
 * {@link StreamAggregator} in ./sse.ts is deliberately single-consumer: it hands each
 * message to whoever reads first, which is right for streaming one subprocess to one
 * client. It cannot back a long-lived broadcast — two dashboard tabs would steal messages
 * from each other, each seeing half the results.
 *
 * This is the opposite trade: every subscriber gets its own queue, and a subscriber that
 * cannot keep up is dropped rather than being allowed to stall the producer. Work must
 * never wait on a browser.
 */

/** How many messages one slow subscriber may fall behind before it is dropped. */
const MAX_QUEUE = 512;

export class Broadcast<T> {
  private readonly subscribers = new Set<{
    queue: T[];
    wake: (() => void) | null;
    closed: boolean;
  }>();

  /** Number of attached subscribers, for diagnostics. */
  get size(): number {
    return this.subscribers.size;
  }

  /**
   * Publish to every subscriber.
   *
   * Never awaits a consumer: a browser that stops reading must not be able to hold up the
   * sweep. An over-full queue means that subscriber is gone in practice, so it is closed.
   */
  publish(message: T): void {
    for (const sub of this.subscribers) {
      if (sub.closed) continue;
      if (sub.queue.length >= MAX_QUEUE) {
        sub.closed = true;
        sub.wake?.();
        continue;
      }
      sub.queue.push(message);
      sub.wake?.();
      sub.wake = null;
    }
  }

  /** Close every subscriber's stream, ending their iteration. */
  closeAll(): void {
    for (const sub of this.subscribers) {
      sub.closed = true;
      sub.wake?.();
    }
    this.subscribers.clear();
  }

  /**
   * Subscribe and iterate messages published from this point on.
   *
   * Callers send their own snapshot first: a late joiner needs current state before
   * deltas make sense, and only the caller knows what a snapshot looks like.
   */
  async *subscribe(signal?: AbortSignal): AsyncGenerator<T> {
    const sub = { queue: [] as T[], wake: null as (() => void) | null, closed: false };
    this.subscribers.add(sub);

    const onAbort = () => { sub.closed = true; sub.wake?.(); };
    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      while (true) {
        while (sub.queue.length > 0) {
          yield sub.queue.shift()!;
        }
        if (sub.closed) return;
        await new Promise<void>(resolve => { sub.wake = resolve; });
      }
    } finally {
      this.subscribers.delete(sub);
      signal?.removeEventListener("abort", onAbort);
    }
  }
}
