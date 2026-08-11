/** Shared SSE streaming utilities used by compose and file operation routes. */

export interface SSEMsg {
  log?:   string;
  ok?:    boolean;
  error?: string;
  /** 0–100 completion, for operations that can report it rather than only logging. */
  progress?: number;
  /**
   * Set alongside `error` when the operation stopped because its output already exists.
   * A flag rather than a parsed message, so the client can offer to replace the file
   * without matching on error text that is free to change.
   */
  conflict?: boolean;
}

export type LogWriter = { write(s: string): Promise<void>; flush(): Promise<void> };

const MAX_BUFFER = 256;

/** Merges parallel readable streams into a single async iterable of SSE messages. */
export class StreamAggregator {
  private readonly buffer: SSEMsg[] = [];
  private consumerResolver: (() => void) | null = null;
  private readonly producerQueue: Array<() => void> = [];
  private done = false;

  /** Enqueue a message; suspends the caller when the buffer is full. */
  async push(data: SSEMsg): Promise<void> {
    // Checked before and after the wait, not only on entry. end() wakes every blocked
    // producer, but a consumer that has stopped leaves the buffer full — so a producer
    // resumed by end() would re-queue itself onto a queue nothing will ever drain again
    // and hang forever, keeping its subprocess and pipes alive with it.
    if (this.done) return;

    // Loop so each resumed producer re-checks capacity before pushing,
    // preventing concurrent producers from bypassing MAX_BUFFER.
    while (this.buffer.length >= MAX_BUFFER) {
      await new Promise<void>(r => { this.producerQueue.push(r); });
      if (this.done) return;
    }
    this.buffer.push(data);
    this.consumerResolver?.();
    this.consumerResolver = null;
  }

  /** Signal that no more messages will be pushed; unblocks all suspended producers. */
  end() {
    this.done = true;
    this.consumerResolver?.();
    this.consumerResolver = null;
    for (const resolve of this.producerQueue) resolve();
    this.producerQueue.length = 0;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SSEMsg> {
    while (true) {
      while (this.buffer.length > 0) {
        yield this.buffer.shift()!;
        this.producerQueue.shift()?.();
      }
      if (this.done) break;
      await new Promise<void>(r => { this.consumerResolver = r; });
    }
  }
}

/** Reads lines from a ReadableStream and forwards each non-empty line as a `{ log }` SSE message. */
export async function drainStream(
  readable: ReadableStream<Uint8Array>,
  push: (data: SSEMsg) => void | Promise<void>,
  logWriter?: LogWriter,
): Promise<void> {
  const reader = readable.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) {
          await push({ log: line });
          if (logWriter) await logWriter.write(line + "\n");
        }
      }
    }
    if (buf.trim()) {
      await push({ log: buf });
      if (logWriter) await logWriter.write(buf + "\n");
    }
  } finally {
    reader.releaseLock();
  }
}
