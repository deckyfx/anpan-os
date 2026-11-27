import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { eq } from "drizzle-orm";
import { stat } from "node:fs/promises";
import { createApp } from "../src/app";
import { db } from "../src/db/index";
import { apiKeys, users } from "../src/db/schema";
import { UserStore } from "../src/stores/user-store";
import { avatarPath, removeAvatar, sniffAvatarType } from "../src/lib/avatar";
import { TEST_JWT, extractCookie } from "./helpers";

/**
 * Avatars: upload, serve, delete — cookie session only. A throwaway user, so the shared
 * admin's status and login responses (asserted in auth.test.ts) keep `avatarUrl: null`.
 */

const app = createApp(TEST_JWT);
const username = `avatar-${crypto.randomUUID().slice(0, 8)}`;
const password = "avatar-password-1";
let cookie = "";
let userId = 0;

const request = (path: string, init: RequestInit = {}) =>
  app.handle(new Request(`http://localhost${path}`, init));

const PNG  = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46]);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 26, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38]);
const GIF  = new TextEncoder().encode("GIF89a\x01\x00\x01\x00");
const SVG  = new TextEncoder().encode(`<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`);

/** PUT a multipart upload with field `file`, named and typed as given. */
function upload(bytes: Uint8Array<ArrayBuffer>, name: string, type: string, headers: Record<string, string> = { cookie }) {
  const form = new FormData();
  form.append("file", new File([bytes], name, { type }));
  return request("/api/auth/avatar", { method: "PUT", headers, body: form });
}

beforeAll(async () => {
  const user = await UserStore.create(username, password);
  userId = user.id;
  const res = await request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  cookie = extractCookie(res).cookie;
});

afterAll(async () => {
  await removeAvatar(userId);
  await db.delete(apiKeys).where(eq(apiKeys.userId, userId));
  await db.delete(users).where(eq(users.id, userId));
});

describe("sniffAvatarType", () => {
  test("knows PNG, JPEG and WebP by their bytes", () => {
    expect(sniffAvatarType(PNG)).toBe("image/png");
    expect(sniffAvatarType(JPEG)).toBe("image/jpeg");
    expect(sniffAvatarType(WEBP)).toBe("image/webp");
  });

  test("refuses GIF, SVG, RIFF that is not WebP, and too-short input", () => {
    expect(sniffAvatarType(GIF)).toBeNull();
    expect(sniffAvatarType(SVG)).toBeNull();
    expect(sniffAvatarType(new TextEncoder().encode("RIFF\0\0\0\0WAVEfmt "))).toBeNull();
    expect(sniffAvatarType(new Uint8Array([0x89, 0x50]))).toBeNull();
    expect(sniffAvatarType(new Uint8Array())).toBeNull();
  });
});

describe("avatar routes", () => {
  test("no cookie → 401 on GET, PUT and DELETE", async () => {
    expect((await request("/api/auth/avatar")).status).toBe(401);
    expect((await upload(PNG, "a.png", "image/png", {})).status).toBe(401);
    expect((await request("/api/auth/avatar", { method: "DELETE" })).status).toBe(401);
  });

  test("GET before any upload → 404 JSON", async () => {
    const res = await request("/api/auth/avatar", { headers: { cookie } });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "No avatar" });
  });

  test("a PNG upload is stored and versioned", async () => {
    const res = await upload(PNG, "me.png", "image/png");
    expect(res.status).toBe(200);
    const { avatarUrl } = await res.json() as { avatarUrl: string };
    expect(avatarUrl).toMatch(/^\/api\/auth\/avatar\?v=\d+$/);

    const file = await stat(avatarPath(userId));
    expect(file.mode & 0o777).toBe(0o600);
    const dir = await stat(avatarPath(userId).replace(/\/[^/]+$/, ""));
    expect(dir.mode & 0o777).toBe(0o700);

    // Reported wherever the client learns who is signed in.
    const status = await request("/api/auth/status", { headers: { cookie } });
    expect(await status.json()).toMatchObject({ authenticated: true, username, avatarUrl });
    const me = await request("/api/me", { headers: { cookie } });
    expect(await me.json()).toMatchObject({ username, avatarUrl });
    const login = await request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    expect(await login.json()).toEqual({ ok: true, username, avatarUrl });
  });

  test("GET returns the bytes, the sniffed type and the hardening headers", async () => {
    const res = await request("/api/auth/avatar?v=1", { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'");
    expect(res.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
  });

  test("the stored type comes from the bytes, not the client's label", async () => {
    // JPEG bytes declared as PNG: accepted, but served as what they are.
    const res = await upload(JPEG, "photo.png", "image/png");
    expect(res.status).toBe(200);
    const got = await request("/api/auth/avatar", { headers: { cookie } });
    expect(got.headers.get("content-type")).toBe("image/jpeg");
    expect((await UserStore.findById(userId))!.avatarType).toBe("image/jpeg");
  });

  test("a .png holding GIF or SVG bytes → 422, and the old avatar stays", async () => {
    for (const bytes of [GIF, SVG]) {
      const res = await upload(bytes, "evil.png", "image/png");
      expect(res.status).toBe(422);
    }
    const got = await request("/api/auth/avatar", { headers: { cookie } });
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(JPEG);
  });

  test("an SVG declared as SVG → 422", async () => {
    expect((await upload(SVG, "a.svg", "image/svg+xml")).status).toBe(422);
  });

  test("over 512 KB → 422 (Elysia's t.File maxSize is a validation error)", async () => {
    const big = new Uint8Array(512 * 1024 + 1);
    big.set(PNG);
    expect((await upload(big, "big.png", "image/png")).status).toBe(422);
  });

  test("exactly 512 KB is accepted", async () => {
    const edge = new Uint8Array(512 * 1024);
    edge.set(PNG);
    expect((await upload(edge, "edge.png", "image/png")).status).toBe(200);
  });

  test("an API key is refused (403) — alone and beside a valid cookie", async () => {
    const minted = await request("/api/api-keys", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "avatar-probe", scope: "full", expiresInDays: null, password }),
    });
    // Without this, a failed mint would send "Bearer undefined", which is refused too, and the
    // test would pass without ever trying a real key.
    expect(minted.status).toBe(200);
    const { key } = await minted.json() as { key: string };
    expect(key).toStartWith("anpan_");
    const auth = { authorization: `Bearer ${key}` };

    expect((await request("/api/auth/avatar", { headers: auth })).status).toBe(403);
    expect((await request("/api/auth/avatar", { headers: { ...auth, cookie } })).status).toBe(403);
    expect((await upload(PNG, "a.png", "image/png", { ...auth, cookie })).status).toBe(403);
    expect((await request("/api/auth/avatar", { method: "DELETE", headers: { ...auth, cookie } })).status).toBe(403);
    // Still there: none of the keyed requests changed anything.
    expect((await request("/api/auth/avatar", { headers: { cookie } })).status).toBe(200);
  });

  test("DELETE clears it; GET then → 404 and status reports null", async () => {
    const del = await request("/api/auth/avatar", { method: "DELETE", headers: { cookie } });
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ ok: true });
    expect(await Bun.file(avatarPath(userId)).exists()).toBe(false);
    expect((await request("/api/auth/avatar", { headers: { cookie } })).status).toBe(404);

    const user = (await UserStore.findById(userId))!;
    expect(user.avatarType).toBeNull();
    // Kept on purpose: it is the URL version, which a later upload must move past.
    expect(user.avatarUpdatedAt).not.toBeNull();
    const status = await request("/api/auth/status", { headers: { cookie } });
    expect(await status.json()).toMatchObject({ username, avatarUrl: null });
  });

  test("every upload gets a new URL, even within the same second and after a removal", async () => {
    const urls: string[] = [];
    for (let i = 0; i < 2; i++) {
      const res = await upload(PNG, "a.png", "image/png");
      urls.push((await res.json() as { avatarUrl: string }).avatarUrl);
    }
    await request("/api/auth/avatar", { method: "DELETE", headers: { cookie } });
    urls.push((await (await upload(PNG, "a.png", "image/png")).json() as { avatarUrl: string }).avatarUrl);
    expect(new Set(urls).size).toBe(3);
  });

  test("an upload and a removal sent together leave row and file agreeing", async () => {
    // Both must succeed: fetch does not reject on an error status, and a refused request
    // would leave row and file agreeing without proving the two were serialized.
    const [put, del] = await Promise.all([
      upload(PNG, "a.png", "image/png"),
      request("/api/auth/avatar", { method: "DELETE", headers: { cookie } }),
    ]);
    expect(put.status).toBe(200);
    expect(del.status).toBe(200);
    const user = (await UserStore.findById(userId))!;
    expect(Boolean(user.avatarType)).toBe(await Bun.file(avatarPath(userId)).exists());
  });

  test("status names nobody without a live session", async () => {
    const res = await request("/api/auth/status");
    expect(await res.json()).toMatchObject({ authenticated: false, username: null, avatarUrl: null });
  });
});
