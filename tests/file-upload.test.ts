import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, readdirSync, utimesSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app";
import { UPLOAD_CHUNK_MAX } from "../src/constants/http";
import { TEST_JWT, loginAs } from "./helpers";

/**
 * Uploads arrive in chunks. The single multipart request they replaced was cut off by Bun's
 * 128 MB body limit, so a 4 GB ISO never arrived and the dialog waited forever; raising the
 * limit needed a global hook, which stopped the SPA being served at all.
 *
 * These pin down what the chunk protocol must guarantee: the bytes arrive intact, a retried
 * chunk is harmless, a gap is refused with the size actually held, nothing replaces the
 * destination before the last byte, and abandoned temp files do not pile up.
 */

const app = createApp(TEST_JWT);
let cookie: string;
let root: string;

function url(dir: string, name: string, id: string, extra = "") {
  return `http://localhost/api/files/upload?path=${encodeURIComponent(dir)}&name=${encodeURIComponent(name)}&id=${id}${extra}`;
}

/** As a browser sends it: an in-process Request carries no Content-Length unless given one. */
function put(name: string, id: string, offset: number, total: number, body: Uint8Array<ArrayBuffer> | string, headers: Record<string, string> = {}) {
  const length = typeof body === "string" ? new TextEncoder().encode(body).byteLength : body.byteLength;
  return app.handle(new Request(url(root, name, id, `&offset=${offset}&total=${total}`), {
    method: "PUT", body, headers: { cookie, "content-length": String(length), ...headers },
  }));
}

const parts = () => readdirSync(root).filter(n => n.endsWith(".part"));

beforeAll(async () => {
  cookie = await loginAs();
  root = mkdtempSync(join(tmpdir(), "anpan-upload-"));
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("chunked upload", () => {
  test("chunks reassemble into the named file, intact, with no temp file left", async () => {
    const bytes = crypto.getRandomValues(new Uint8Array(3 * 1024 * 1024));
    const id = crypto.randomUUID();
    const size = 1024 * 1024;
    for (let off = 0; off < bytes.length; off += size) {
      const res = await put("blob.bin", id, off, bytes.length, bytes.slice(off, off + size));
      expect(res.status).toBe(200);
      expect((await res.json()).received).toBe(Math.min(off + size, bytes.length));
    }
    expect(new Uint8Array(await Bun.file(join(root, "blob.bin")).arrayBuffer())).toEqual(bytes);
    expect(parts()).toEqual([]);
  });

  test("a retried chunk overwrites rather than duplicates", async () => {
    const id = crypto.randomUUID();
    await put("retry.txt", id, 0, 6, "abc");
    await put("retry.txt", id, 0, 6, "abc");
    await put("retry.txt", id, 3, 6, "def");
    expect(await Bun.file(join(root, "retry.txt")).text()).toBe("abcdef");
  });

  test("a chunk past what the server holds is refused with the size it has", async () => {
    const id = crypto.randomUUID();
    await put("gap.txt", id, 0, 9, "abc");
    const res = await put("gap.txt", id, 6, 9, "ghi");
    expect(res.status).toBe(409);
    expect((await res.json()).received).toBe(3);
    await app.handle(new Request(url(root, "gap.txt", id), { method: "DELETE", headers: { cookie } }));
  });

  test("the destination is not replaced until the last byte arrives", async () => {
    await Bun.write(join(root, "keep.txt"), "good");
    const id = crypto.randomUUID();
    await put("keep.txt", id, 0, 8, "half");
    expect(await Bun.file(join(root, "keep.txt")).text()).toBe("good");

    await app.handle(new Request(url(root, "keep.txt", id), { method: "DELETE", headers: { cookie } }));
    expect(await Bun.file(join(root, "keep.txt")).text()).toBe("good");
    expect(parts()).toEqual([]);
  });

  test("a body shorter than its declared length is refused", async () => {
    const res = await put("short.txt", crypto.randomUUID(), 0, 1000, "trunc", { "content-length": "1000" });
    expect(res.status).toBe(400);
    expect(await Bun.file(join(root, "short.txt")).exists()).toBe(false);
    expect(parts()).toEqual([]);
  });

  test("a chunk over the cap is refused before it is read", async () => {
    const res = await put("big.bin", crypto.randomUUID(), 0, UPLOAD_CHUNK_MAX + 1, "x",
      { "content-length": String(UPLOAD_CHUNK_MAX + 1) });
    expect(res.status).toBe(413);
  });

  test("an empty file uploads", async () => {
    const res = await put("empty.txt", crypto.randomUUID(), 0, 0, "");
    expect(res.status).toBe(200);
    expect(Bun.file(join(root, "empty.txt")).size).toBe(0);
  });

  test("names and ids that are not plain are refused", async () => {
    for (const name of ["../escape.txt", "a/b.txt", "..", "."]) {
      expect((await put(name, crypto.randomUUID(), 0, 1, "x")).status).toBe(400);
    }
    expect((await put("ok.txt", "../../etc", 0, 1, "x")).status).toBe(400);
  });

  test("abandoning an upload refuses the same names the upload does", async () => {
    // The abandon route once checked only for a separator, so "." and ".." passed it.
    for (const name of ["..", ".", "a/b.txt", ""]) {
      const res = await app.handle(new Request(url(root, name, crypto.randomUUID()), {
        method: "DELETE", headers: { cookie },
      }));
      expect(res.status).toBe(400);
    }
  });

  test("offset and total must be whole numbers", async () => {
    // A fractional total could never be reached, so the upload could never finish.
    expect((await put("frac.txt", crypto.randomUUID(), 0, 10.5, "x")).status).toBe(400);
    expect((await put("frac.txt", crypto.randomUUID(), 0.5, 10, "x")).status).toBe(400);
    expect(parts().filter(n => n.includes("frac.txt"))).toEqual([]);
  });

  test("a missing Content-Length is 411, a malformed one is 400", async () => {
    const send = (headers: Record<string, string>) =>
      app.handle(new Request(url(root, "len.txt", crypto.randomUUID(), "&offset=0&total=1"), {
        method: "PUT", body: "x", headers: { cookie, ...headers },
      }));
    expect((await send({})).status).toBe(411);
    for (const bad of ["-1", "1.5", "abc"]) {
      const res = await send({ "content-length": bad });
      expect(res.status).toBe(400);
      // The reason, not only the status: before, a negative or fractional length also got a
      // 400, but as "Upload was interrupted", after the temp file had been opened and cut.
      expect(((await res.json()) as { error: string }).error).toContain("Content-Length");
    }
    expect(parts().filter(n => n.startsWith(".len.txt."))).toEqual([]);
  });

  test("without a session nothing is written", async () => {
    const res = await app.handle(new Request(url(root, "anon.txt", crypto.randomUUID(), "&offset=0&total=1"), {
      method: "PUT", body: "x",
    }));
    expect(res.status).toBe(401);
    expect(await Bun.file(join(root, "anon.txt")).exists()).toBe(false);
  });

  test("starting an upload sweeps that name's abandoned temp files, and only stale ones", async () => {
    const stale = join(root, `.sweep.txt.${crypto.randomUUID()}.part`);
    const fresh = join(root, `.sweep.txt.${crypto.randomUUID()}.part`);
    const other = join(root, `.other.txt.${crypto.randomUUID()}.part`);
    for (const p of [stale, fresh, other]) await Bun.write(p, "partial");
    const twoDaysAgo = (Date.now() - 2 * 24 * 60 * 60 * 1000) / 1000;
    utimesSync(stale, twoDaysAgo, twoDaysAgo);
    utimesSync(other, twoDaysAgo, twoDaysAgo);

    await put("sweep.txt", crypto.randomUUID(), 0, 1, "x");

    expect(await Bun.file(stale).exists()).toBe(false);
    expect(await Bun.file(fresh).exists()).toBe(true);
    expect(await Bun.file(other).exists()).toBe(true);
    rmSync(fresh); rmSync(other);
  });

  test("a retry overlapping a stalled request cannot cut the committed file short", async () => {
    // The client's watchdog gives up on a chunk after 60 s without progress and sends it
    // again, while the server may still be inside the first request. Unserialised, the
    // retry reopened the same temp file, finished and renamed it into place -- and the
    // stalled request, when its connection finally died, truncated the inode it still held,
    // which by then was the committed upload.
    const name  = "overlap.bin";
    const id    = crypto.randomUUID();
    const data  = new Uint8Array(64 * 1024).map((_, i) => i % 251);
    const total = data.byteLength;
    const dest  = join(root, name);

    /** Poll until `cond` holds, or give up after `ms`. */
    const waitFor = async (cond: () => boolean, ms: number) => {
      for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(5)) if (cond()) return true;
      return false;
    };

    // The first request sends half its chunk and then stalls.
    let feed!: ReadableStreamDefaultController<Uint8Array>;
    const stalledBody = new ReadableStream<Uint8Array>({ start(c) { feed = c; } });
    const first = app.handle(new Request(url(root, name, id, `&offset=0&total=${total}`), {
      method: "PUT", body: stalledBody, duplex: "half",
      headers: { cookie, "content-length": String(total) },
    } as RequestInit));
    feed.enqueue(data.slice(0, total / 2));
    // Only this upload's temp file: another test's leftovers must not decide this one.
    const mine = () => parts().filter(n => n.startsWith(`.${name}.`));
    const held = await waitFor(() => mine().length === 1 && statSync(join(root, mine()[0]!)).size === total / 2, 2000);
    expect(held).toBe(true);

    // The client's retry of the same chunk, complete. Unserialised it finishes at once.
    const retry = put(name, id, 0, total, data);
    await waitFor(() => existsSync(dest), 300);

    // The stalled connection dies.
    feed.close();
    expect((await first).status).toBe(400);
    expect((await retry).status).toBe(200);

    const landed = await Bun.file(dest).bytes();
    expect(landed.byteLength).toBe(total);
    expect(Buffer.from(landed).equals(Buffer.from(data))).toBe(true);
    expect(mine()).toEqual([]);
    rmSync(dest);
  });
});
