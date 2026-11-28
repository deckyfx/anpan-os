/**
 * Sending a file in chunks: the browser half of the uploader the Files page and the
 * Backups page share. The server half is src/lib/chunked-upload.ts.
 *
 * Each chunk is one PUT of at most UPLOAD_CHUNK_SIZE bytes to `<base>&offset=…&total=…`, and
 * the upload is abandoned with DELETE `<base>`. A lost or stalled chunk is retried on its
 * own, and a 409 resumes from what the server says it holds.
 */
import { UPLOAD_CHUNK_SIZE } from "../../../constants/http";

/** No upload progress for this long means the connection is gone, even if nothing said so. */
const UPLOAD_STALL_MS = 60_000;
/** Tries per chunk before the file is given up; the wait between them doubles from 1 s. */
const UPLOAD_ATTEMPTS = 4;

/**
 * A new upload id, in the UUID form the server checks for.
 *
 * `crypto.randomUUID` exists only on secure origins (HTTPS, localhost), and anpan-os is
 * also opened over plain HTTP on a LAN address. `getRandomValues` has no such limit, so
 * the same version-4 UUID is made from it there.
 */
export function newUploadId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40; // version 4
  b[8] = (b[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const hex = [...b].map(x => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Lets the page cancel an upload: remembers the chunk in flight, and whether to stop. */
export class UploadControl {
  private active: XMLHttpRequest | null = null;
  private stop = false;

  /** Whether Cancel was pressed since the last {@link reset}. */
  get cancelled(): boolean {
    return this.stop;
  }

  /** Clear a previous Cancel, before a new upload. */
  reset(): void {
    this.stop = false;
  }

  /** Stop the upload: the chunk in flight is aborted, and no further one is sent. */
  cancel(): void {
    this.stop = true;
    this.active?.abort();
  }

  /** @internal The chunk now in flight, or null. */
  track(xhr: XMLHttpRequest | null): void {
    this.active = xhr;
  }
}

type ChunkResult =
  | { kind: "ok";        received: number }
  | { kind: "resync";    received: number }  // 409: the server holds less than we sent
  | { kind: "retry";     message: string }   // lost, stalled or a server error — worth another try
  | { kind: "fail";      message: string }   // a refusal that another try would get again
  | { kind: "cancelled" };

/**
 * PUT one chunk. Every way an XHR can end resolves the promise, and a watchdog aborts one
 * that stops making progress: a dropped connection does not always raise an error, and
 * before this the dialog waited on it forever.
 */
function sendChunk(url: string, body: Blob, onProgress: (loaded: number) => void, control: UploadControl): Promise<ChunkResult> {
  return new Promise(resolve => {
    const xhr = new XMLHttpRequest();
    control.track(xhr);
    let stalled = false;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const arm  = () => { clearTimeout(watchdog); watchdog = setTimeout(() => { stalled = true; xhr.abort(); }, UPLOAD_STALL_MS); };
    const done = (result: ChunkResult) => { clearTimeout(watchdog); control.track(null); resolve(result); };

    xhr.upload.onprogress = (e) => { arm(); onProgress(e.loaded); };
    xhr.onload = () => {
      let reply: { error?: string; received?: number } = {};
      try {
        const parsed: unknown = JSON.parse(xhr.responseText);
        // JSON, but `null` or a bare value: no fields to read; the status decides.
        if (typeof parsed === "object" && parsed !== null) reply = parsed;
      } catch { /* not JSON */ }
      if (xhr.status >= 200 && xhr.status < 300 && typeof reply.received === "number") {
        return done({ kind: "ok", received: reply.received });
      }
      if (xhr.status === 409 && typeof reply.received === "number") return done({ kind: "resync", received: reply.received });
      const message = reply.error ?? `Upload failed (HTTP ${xhr.status})`;
      // Writing a chunk is idempotent, so a server error is worth retrying; a full disk is not.
      done(xhr.status >= 500 && xhr.status !== 507 ? { kind: "retry", message } : { kind: "fail", message });
    };
    xhr.onerror = () => done({ kind: "retry", message: "Connection lost" });
    xhr.onabort = () => done(stalled
      ? { kind: "retry", message: `Stalled — no progress for ${UPLOAD_STALL_MS / 1000} s` }
      : { kind: "cancelled" });
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    arm();
    xhr.send(body);
  });
}

/**
 * Upload `file` chunk by chunk to `base` (a URL with its query already started). Resolves
 * with null once it is in place, or with the reason it stopped — in which case the server's
 * partial copy has been asked to go.
 */
export async function uploadInChunks(
  base: string,
  file: File,
  onProgress: (loaded: number) => void,
  control: UploadControl,
): Promise<string | null> {
  const abandon = async (reason: string) => {
    // Best effort, and bounded: a cleanup request that hangs must not keep the upload open.
    await fetch(base, { method: "DELETE", signal: AbortSignal.timeout(10_000) }).catch(() => {});
    return reason;
  };

  let offset   = 0;
  let failures = 0;
  do {
    if (control.cancelled) return abandon("Cancelled");
    const end    = Math.min(offset + UPLOAD_CHUNK_SIZE, file.size);
    const start  = offset;
    const result = await sendChunk(`${base}&offset=${start}&total=${file.size}`, file.slice(start, end), loaded => onProgress(start + loaded), control);

    if (result.kind === "cancelled") return abandon("Cancelled");
    if (result.kind === "fail")      return abandon(result.message);
    if (result.kind === "ok" && (result.received > start || file.size === 0)) {
      offset = result.received;
      failures = 0;
      onProgress(offset);
      continue;
    }
    // A retry, a resync, or a reply that made no progress: each counts against the budget,
    // so a server that keeps answering 409 cannot hold the dialog open forever.
    const message = result.kind === "retry" ? result.message : "The server did not accept the data";
    if (++failures >= UPLOAD_ATTEMPTS) return abandon(message);
    if (result.kind === "resync") offset = result.received;
    else await new Promise(r => setTimeout(r, 1000 * 2 ** (failures - 1)));
  } while (offset < file.size);
  return null;
}
