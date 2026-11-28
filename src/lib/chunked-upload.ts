/**
 * Receiving a file in chunks: the server half of the uploader the Files page and the
 * Backups page share.
 *
 * Each chunk is one PUT with the raw bytes as its body (see UPLOAD_CHUNK_SIZE for why
 * chunks). Chunks accumulate in a hidden temp file named by the upload id, beside the
 * destination, which is renamed into place only when the last byte has arrived — an
 * interrupted upload never leaves a truncated file under the real name, or replaces a good
 * one with it.
 *
 * Chunks must arrive in order. One at an offset the temp file already covers is a retry
 * and overwrites from there; one past its end would leave a gap, and is refused with 409
 * and the size actually held, so the client resumes from what the server has.
 */
import { basename, dirname, join } from "node:path";
import { open, readdir, rename, rm, stat } from "node:fs/promises";
import { KeyedLock } from "./keyed-lock";
import { UPLOAD_CHUNK_MAX, UPLOAD_ID_RE } from "../constants/http";

/** The answer to a chunk that was taken. */
export interface ChunkReply {
  ok:       true;
  /** The last byte has arrived and the file is in place. */
  done:     boolean;
  received: number;
}

/** Hidden, beside the destination: same filesystem, so the final rename is atomic. */
export function uploadTempPath(dest: string, id: string): string {
  return join(dirname(dest), `.${basename(dest)}.${id}.part`);
}

/** A temp file nobody has written to for this long belongs to an upload that is not coming back. */
const STALE_UPLOAD_MS = 24 * 60 * 60 * 1000;

/**
 * Remove abandoned temp files for `name` in `dir`. A closed tab or a dead laptop never sends
 * the DELETE, so without this every abandoned upload would leave its partial copy behind.
 * Only files matching the temp-name pattern exactly are touched.
 */
export async function sweepStaleUploads(dir: string, name: string): Promise<void> {
  const prefix = `.${name}.`;
  const entries = await readdir(dir).catch(() => [] as string[]);
  const cutoff = Date.now() - STALE_UPLOAD_MS;
  await Promise.all(entries.map(async entry => {
    if (!entry.startsWith(prefix) || !entry.endsWith(".part")) return;
    if (!UPLOAD_ID_RE.test(entry.slice(prefix.length, -".part".length))) return;
    const path = join(dir, entry);
    const info = await stat(path).catch(() => null);
    if (info && info.mtimeMs < cutoff) await rm(path, { force: true }).catch(() => {});
  }));
}

/**
 * One upload's temp file is touched by one request at a time.
 *
 * Without this, a retry could overlap the stalled request it replaces. The client's watchdog
 * aborts a chunk after 60 s without progress and resends it, while the server may still be
 * inside the earlier request: an offset-0 retry reopened the file with "w" mid-write, and the
 * earlier handler then truncated it -- after the retry had already renamed it into place,
 * since a file handle follows its inode. The committed upload came out short.
 *
 * Holding the lock across the body read cannot hang a retry indefinitely: Bun.serve closes a
 * connection idle for 10 s (its default, which nothing here overrides), including one whose
 * request body has stalled. A retry therefore waits seconds behind a dead request, well inside
 * the client's 60 s watchdog.
 */
const uploadLock = new KeyedLock();

/**
 * Refuse a chunk whose id or byte positions are not valid, before anything is resolved.
 * Null when they are.
 */
export function checkChunkQuery(q: { id: string; offset: number; total: number }): Response | null {
  if (!UPLOAD_ID_RE.test(q.id)) return Response.json({ error: "Invalid upload id" }, { status: 400 });
  // Byte positions are whole numbers. The schema enforces only a minimum of 0, so a
  // fractional total (10.5) passed, and could then never be reached: every chunk either
  // left the upload short of it or was refused for running past it.
  if (!Number.isSafeInteger(q.offset) || !Number.isSafeInteger(q.total)) {
    return Response.json({ error: "offset and total must be whole numbers" }, { status: 400 });
  }
  return null;
}

/**
 * Write one chunk of upload `q.id` for `dest`, from `request`'s body.
 *
 * `onFirstChunk` runs, under the upload's lock, before the first chunk is written.
 * `mayCommit` runs under the lock right before the finished file is renamed into place;
 * when it answers false the upload is refused (409) and the file left as it was.
 */
export async function receiveChunk(
  dest: string,
  q: { id: string; offset: number; total: number },
  request: Request,
  onFirstChunk?: () => Promise<void>,
  mayCommit?: () => boolean,
): Promise<Response | ChunkReply> {
  const refused = checkChunkQuery(q);
  if (refused) return refused;
  const { offset, total } = q;
  const tmp = uploadTempPath(dest, q.id);

  const rawLength = request.headers.get("content-length");
  if (rawLength === null) return Response.json({ error: "Content-Length is required" }, { status: 411 });
  // Present but not a byte count is a different fault from absent: a 400, not a 411.
  const declared = Number(rawLength);
  if (!Number.isSafeInteger(declared) || declared < 0) {
    return Response.json({ error: "Content-Length must be a whole number of bytes" }, { status: 400 });
  }
  if (declared > UPLOAD_CHUNK_MAX) return Response.json({ error: "File too large" }, { status: 413 });
  if (offset + declared > total) return Response.json({ error: "Chunk runs past the end of the file" }, { status: 400 });

  return uploadLock.run(tmp, async () => { try {
    if (offset === 0) {
      await onFirstChunk?.();
    } else {
      const held = await stat(tmp).then(s => s.size, () => 0);
      if (held < offset) return Response.json({ error: "Upload is out of step", received: held }, { status: 409 });
    }

    // Written as it arrives rather than buffered: reading each chunk whole put the
    // server's memory at ~320 MB during a 4 GB upload, which a Raspberry Pi feels.
    let written = 0;
    const fh = await open(tmp, offset === 0 ? "w" : "r+");
    try {
      if (request.body) {
        for await (const part of request.body) {
          if (written + part.byteLength > declared) break;
          // A write may take fewer bytes than given; write the rest, so `written` counts
          // only what is in the file.
          for (let done = 0; done < part.byteLength;) {
            const { bytesWritten } = await fh.write(part, done, part.byteLength - done, offset + written + done);
            if (bytesWritten <= 0) throw new Error("Short write");
            done += bytesWritten;
          }
          written += part.byteLength;
        }
      }
      // A dropped connection can end the body early without an error; the declared
      // length is the only way to tell a short read from a short chunk. Cut the file
      // back to what was held before, so a retry of this chunk starts clean.
      if (written !== declared) await fh.truncate(offset);
      else await fh.truncate(offset + written);
    } finally {
      await fh.close();
    }
    if (written !== declared) {
      if (offset === 0) await rm(tmp, { force: true });
      return Response.json({ error: "Upload was interrupted", received: offset }, { status: 400 });
    }

    const received = offset + written;
    if (received < total) return { ok: true as const, done: false, received };
    if (mayCommit && !mayCommit()) {
      await rm(tmp, { force: true });
      return Response.json({ error: "This upload has already been taken", received: 0 }, { status: 409 });
    }
    await rename(tmp, dest);
    return { ok: true as const, done: true, received };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOSPC") {
      await rm(tmp, { force: true }).catch(() => {});
      return Response.json({ error: "Not enough space on the destination drive" }, { status: 507 });
    }
    return Response.json({ error: "Internal server error" }, { status: 500 });
  } });
}

/** Drop upload `id`'s temp file for `dest`. Under the chunks' lock, so no write is in flight. */
export async function abandonUpload(dest: string, id: string): Promise<void> {
  // Removing the file under an in-flight write leaves that request writing to an unlinked
  // inode and failing its rename.
  const tmp = uploadTempPath(dest, id);
  await uploadLock.run(tmp, () => rm(tmp, { force: true }));
}
