/**
 * Serialises async work per key, within this process.
 *
 * Callers sharing a key run one at a time, in arrival order; callers with different keys do
 * not wait for each other. In-process is enough wherever the thing being protected is only
 * ever touched by this server — there is one server process, and a cross-process lock (as
 * the migration manager needs) would be machinery with nothing to guard against.
 */
export class KeyedLock {
  /** The promise each key's next caller must wait for — the end of the current queue. */
  private readonly tails = new Map<string, Promise<void>>();

  /**
   * Run `fn` once every earlier caller for `key` has finished.
   *
   * The lock is released whether `fn` resolves or throws, so one failed holder cannot wedge
   * every later caller behind it.
   */
  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>(resolve => { release = resolve; });
    const tail = previous.then(() => mine);
    this.tails.set(key, tail);

    try {
      await previous;
      return await fn();
    } finally {
      release();
      // Drop the entry only if nobody queued behind us, so the map holds keys with work
      // running or waiting and cannot grow with every key ever used.
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }

  /** Number of keys with work running or queued. */
  get size(): number {
    return this.tails.size;
  }
}
