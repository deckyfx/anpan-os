import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, readdirSync, utimesSync } from "node:fs";
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
});
