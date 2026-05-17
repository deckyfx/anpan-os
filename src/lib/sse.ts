/** Shared SSE streaming utilities used by compose and file operation routes. */

export interface SSEMsg { log?: string; ok?: boolean; error?: string }

export type LogWriter = { write(s: string): Promise<void>; flush(): Promise<void> };

const MAX_BUFFER = 256;

/** Merges parallel readable streams into a single async iterable of SSE messages. */
export class StreamAggregator {
  private readonly buffer: SSEMsg[] = [];
  private consumerResolver: (() => void) | null = null;
  private readonly producerQueue: Array<() => void> = [];
  private done = false;

  async push(data: SSEMsg): Promise<void> {
    if (this.buffer.length >= MAX_BUFFER) {
      await new Promise<void>(r => { this.producerQueue.push(r); });
    }
    this.buffer.push(data);
    this.consumerResolver?.();
    this.consumerResolver = null;
  }

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
