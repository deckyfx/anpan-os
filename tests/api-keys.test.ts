import { test, expect, describe, beforeAll, afterAll, spyOn } from "bun:test";
import { eq } from "drizzle-orm";
import { createApp } from "../src/app";
import { db } from "../src/db/index";
import { apiKeys, users } from "../src/db/schema";
import { UserStore } from "../src/stores/user-store";
import { ApiKeyStore, MAX_API_KEYS_PER_USER } from "../src/stores/api-key-store";
import { noteApiKeyUse, parseApiKeyToken } from "../src/lib/api-key-auth";
import { TEST_JWT, extractCookie } from "./helpers";

/**
 * API keys end to end: minted with the browser session, then used as Bearer tokens on the
 * real routes. Routes are ones that answer without Docker — /api/me, /api/system/stats and
 * bookmarks — so the suite means the same in CI as on a dev box.
 *
 * A throwaway user, so the keys and the cap test never touch the shared admin account.
 */

const app = createApp(TEST_JWT);
const username = `keys-${crypto.randomUUID().slice(0, 8)}`;
const password = "keys-password-1";
let cookie = "";
let userId = 0;

const request = (path: string, init: RequestInit = {}) =>
  app.handle(new Request(`http://localhost${path}`, init));

const bearer = (token: string, extra: Record<string, string> = {}) =>
  ({ authorization: `Bearer ${token}`, ...extra });

interface KeyView {
  id: string; name: string; scope: string;
  createdAt: string; expiresAt: string | null; lastUsedAt: string | null; lastUsedIp: string | null;
}

/** Mint a key through the API with the cookie, as the web UI does. */
async function mint(scope: string, name = `${scope}-key`, expiresInDays: number | null = null) {
  const res = await request("/api/api-keys", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ name, scope, expiresInDays, password }),
  });
  expect(res.status).toBe(200);
  return await res.json() as { key: string; apiKey: KeyView };
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
  await db.delete(apiKeys).where(eq(apiKeys.userId, userId));
  await db.delete(users).where(eq(users.id, userId));
});

describe("minting and listing", () => {
  test("POST returns the token once, shaped anpan_<id>_<secret>", async () => {
    const { key, apiKey } = await mint("read", "  padded name  ", 30);
    const parsed = parseApiKeyToken(key);
    expect(parsed).not.toBeNull();
    expect(parsed!.id).toBe(apiKey.id);
    expect(apiKey).toMatchObject({ name: "padded name", scope: "read", lastUsedAt: null, lastUsedIp: null });
    const days = (Date.parse(apiKey.expiresAt!) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThanOrEqual(30);
  });

  test("the list never carries the secret or its hash", async () => {
    const { key, apiKey } = await mint("full");
    const secret = parseApiKeyToken(key)!.secret;
    const row = (await db.select().from(apiKeys).where(eq(apiKeys.id, apiKey.id)))[0]!;

    const res = await request("/api/api-keys", { headers: { cookie } });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(secret);
    expect(text).not.toContain(row.secretHash);
    expect(text).not.toContain("secretHash");
    const { keys } = JSON.parse(text) as { keys: KeyView[] };
    expect(keys.map(k => k.id)).toContain(apiKey.id);
    expect(Object.keys(keys[0]!).sort()).toEqual(
      ["createdAt", "expiresAt", "id", "lastUsedAt", "lastUsedIp", "name", "scope"],
    );
  });

  test("only a hash of the secret is stored", async () => {
    const { key, apiKey } = await mint("read");
    const row = (await db.select().from(apiKeys).where(eq(apiKeys.id, apiKey.id)))[0]!;
    expect(row.secretHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(parseApiKeyToken(key)!.secret);
  });

  test.each([
    [{ name: "x", scope: "admin", expiresInDays: null, password }],
    [{ name: "x", scope: "read", expiresInDays: 0, password }],
    [{ name: "x", scope: "read", expiresInDays: 3651, password }],
    [{ name: "x", scope: "read", expiresInDays: 1.5, password }],
    [{ name: "x", scope: "read" }],
    [{ name: "", scope: "read", expiresInDays: null, password }],
    [{ name: "   ", scope: "read", expiresInDays: null, password }],
    [{ name: "a".repeat(65), scope: "read", expiresInDays: null, password }],
    [{ name: "line\nbreak", scope: "read", expiresInDays: null, password }],
  ])("rejects a bad body %j with 422", async (body) => {
    const res = await request("/api/api-keys", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(422);
  });

  test("a cross-site page cannot mint a key with the victim's cookie", async () => {
    const res = await request("/api/api-keys", {
      method: "POST",
      headers: { cookie, "content-type": "application/json", origin: "https://evil.example" },
      body: JSON.stringify({ name: "x", scope: "full", expiresInDays: null, password }),
    });
    expect(res.status).toBe(403);
  });

  test(`more than ${MAX_API_KEYS_PER_USER} keys → 409`, async () => {
    const held = (await ApiKeyStore.listFor(userId)).length;
    for (let i = held; i < MAX_API_KEYS_PER_USER; i++) await mint("read", `filler-${i}`);
    const res = await request("/api/api-keys", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "one too many", scope: "read", expiresInDays: null, password }),
    });
    expect(res.status).toBe(409);
    // Make room again for the tests below.
    for (const k of await ApiKeyStore.listFor(userId)) {
      if (k.name.startsWith("filler-")) await ApiKeyStore.delete(k.id, userId);
    }
  });
});

describe("management is cookie-only", () => {
  test("no cookie → 401", async () => {
    expect((await request("/api/api-keys")).status).toBe(401);
  });

  test("a full key cannot list, mint or delete keys — even beside a valid cookie", async () => {
    const { key, apiKey } = await mint("full");
    for (const headers of [bearer(key), bearer(key, { cookie })]) {
      expect((await request("/api/api-keys", { headers })).status).toBe(403);
      expect((await request("/api/api-keys", {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ name: "minted by a key", scope: "full", expiresInDays: null, password }),
      })).status).toBe(403);
      expect((await request(`/api/api-keys/${apiKey.id}`, { method: "DELETE", headers })).status).toBe(403);
    }
    expect((await ApiKeyStore.listFor(userId)).some(k => k.name === "minted by a key")).toBe(false);
  });

  test("DELETE of a key that is not the caller's → 404, and it survives", async () => {
    const other = await UserStore.create(`keys-other-${crypto.randomUUID().slice(0, 8)}`, "other-password-1");
    try {
      const id = "abcdef012345";
      ApiKeyStore.create({ id, userId: other.id, name: "theirs", scope: "full", secretHash: "0".repeat(64) });
      const res = await request(`/api/api-keys/${id}`, { method: "DELETE", headers: { cookie } });
      expect(res.status).toBe(404);
      expect(await ApiKeyStore.findWithUser(id)).not.toBeNull();
    } finally {
      await db.delete(apiKeys).where(eq(apiKeys.userId, other.id));
      await db.delete(users).where(eq(users.id, other.id));
    }
  });

  test("DELETE with a malformed id → 422", async () => {
    expect((await request("/api/api-keys/not-an-id", { method: "DELETE", headers: { cookie } })).status).toBe(422);
  });
});

describe("using a key", () => {
  test("a read key reads, as its owner", async () => {
    const { key } = await mint("read");
    const me = await request("/api/me", { headers: bearer(key) });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ sub: String(userId), username });

    const stats = await request("/api/system/stats", { headers: bearer(key) });
    expect(stats.status).toBe(200);
  });

  test("a write outside the scope → 403 naming the scope and the request", async () => {
    const { key } = await mint("read");
    const res = await request("/api/bookmarks", {
      method: "POST",
      headers: { ...bearer(key), "content-type": "application/json" },
      body: JSON.stringify({ title: "nope", url: "https://example.com" }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "This API key's scope (read) does not allow POST /api/bookmarks" });
  });

  test("a read key cannot read files; a full key can", async () => {
    const { key: readKey } = await mint("read");
    const { key: fullKey } = await mint("full");
    expect((await request("/api/files/home", { headers: bearer(readKey) })).status).toBe(403);
    expect((await request("/api/files/home", { headers: bearer(fullKey) })).status).toBe(200);
  });

  test("an operate key writes bookmarks and logs the write; prune stays full-only", async () => {
    const { key, apiKey } = await mint("operate", "agent-007");
    const log = spyOn(console, "log");
    try {
      const res = await request("/api/bookmarks", {
        method: "POST",
        headers: { ...bearer(key), "content-type": "application/json" },
        body: JSON.stringify({ title: "via key", url: "https://example.com" }),
      });
      expect(res.status).toBe(201);
      const created = await res.json() as { id: number };
      expect(log).toHaveBeenCalledWith(`[api-key] agent-007 (${apiKey.id}) POST /api/bookmarks`);
      const del = await request(`/api/bookmarks/${created.id}`, { method: "DELETE", headers: bearer(key) });
      expect(del.status).toBe(200);
    } finally {
      log.mockRestore();
    }

    // `confirm` deliberately does not repeat the category, so that even with the scope check
    // broken the handler answers 422 before pruning anything on a dev box that has Docker.
    const prune = await request("/api/docker/prune", {
      method: "POST",
      headers: { ...bearer(key), "content-type": "application/json" },
      body: JSON.stringify({ category: "dangling-images", confirm: "no" }),
    });
    expect(prune.status).toBe(403);
  });

  test("a wrong secret → 401, with no fallback to a valid cookie sent alongside", async () => {
    const { key } = await mint("full");
    const parsed = parseApiKeyToken(key)!;
    const flipped = parsed.secret[0] === "A" ? "B" : "A";
    const wrong = `anpan_${parsed.id}_${flipped}${parsed.secret.slice(1)}`;

    const alone = await request("/api/me", { headers: bearer(wrong) });
    expect(alone.status).toBe(401);
    expect(alone.headers.get("www-authenticate")).toContain("Bearer");

    const withCookie = await request("/api/me", { headers: bearer(wrong, { cookie }) });
    expect(withCookie.status).toBe(401);
  });

  test("a malformed or empty Bearer credential → 401 even with a valid cookie", async () => {
    for (const authorization of ["Bearer nonsense", "Bearer ", "bearer anpan_zz_zz"]) {
      const res = await request("/api/me", { headers: { authorization, cookie } });
      expect(res.status).toBe(401);
    }
  });

  test("a non-Bearer Authorization header (a proxy's Basic auth) leaves the cookie path alone", async () => {
    const res = await request("/api/me", { headers: { authorization: "Basic dXNlcjpwYXNz", cookie } });
    expect(res.status).toBe(200);
  });

  test("a deleted key → 401", async () => {
    const { key, apiKey } = await mint("read");
    expect((await request("/api/me", { headers: bearer(key) })).status).toBe(200);
    const del = await request(`/api/api-keys/${apiKey.id}`, { method: "DELETE", headers: { cookie } });
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ ok: true });
    expect((await request("/api/me", { headers: bearer(key) })).status).toBe(401);
  });

  test("an expired key → 401", async () => {
    const { key, apiKey } = await mint("read", "short-lived", 1);
    expect((await request("/api/me", { headers: bearer(key) })).status).toBe(200);
    await ApiKeyStore.setExpiresAt(apiKey.id, new Date(Date.now() - 1000));
    expect((await request("/api/me", { headers: bearer(key) })).status).toBe(401);
  });

  test("a key whose user is gone → 401", async () => {
    const other = await UserStore.create(`keys-gone-${crypto.randomUUID().slice(0, 8)}`, "other-password-1");
    const { generateApiKeyToken } = await import("../src/lib/api-key-auth");
    const { id, token, secretHash } = generateApiKeyToken();
    ApiKeyStore.create({ id, userId: other.id, name: "orphan", scope: "full", secretHash });
    expect((await request("/api/me", { headers: bearer(token) })).status).toBe(200);
    await db.delete(users).where(eq(users.id, other.id));
    try {
      expect((await request("/api/me", { headers: bearer(token) })).status).toBe(401);
    } finally {
      await db.delete(apiKeys).where(eq(apiKeys.id, id));
    }
  });

  test("a key cannot reach the account routes behind authGuard (passkey registration)", async () => {
    const { key } = await mint("full");
    const res = await request("/api/auth/passkey/credentials", { headers: bearer(key) });
    expect(res.status).toBe(403);
  });

  test("use is recorded in lastUsedAt", async () => {
    const { key, apiKey } = await mint("read");
    expect((await request("/api/me", { headers: bearer(key) })).status).toBe(200);
    const row = await ApiKeyStore.findWithUser(apiKey.id);
    expect(row!.key.lastUsedAt).not.toBeNull();
  });
});

describe("noteApiKeyUse throttle", () => {
  test("writes at most once a minute per key", async () => {
    const { apiKey } = await mint("read");
    const t0 = Date.UTC(2030, 0, 1, 12, 0, 0);
    await noteApiKeyUse(apiKey.id, "10.0.0.1", t0);
    await noteApiKeyUse(apiKey.id, "10.0.0.2", t0 + 59_000);
    let row = (await ApiKeyStore.findWithUser(apiKey.id))!.key;
    expect(row.lastUsedIp).toBe("10.0.0.1");
    expect(row.lastUsedAt!.getTime()).toBe(t0);

    await noteApiKeyUse(apiKey.id, "10.0.0.3", t0 + 60_000);
    row = (await ApiKeyStore.findWithUser(apiKey.id))!.key;
    expect(row.lastUsedIp).toBe("10.0.0.3");
    expect(row.lastUsedAt!.getTime()).toBe(t0 + 60_000);
  });
});

describe("creating a key needs the current password", () => {
  const post = (body: Record<string, unknown>) => request("/api/api-keys", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  test("a wrong password is refused with 400 and creates nothing", async () => {
    const before = (await ApiKeyStore.listFor(userId)).length;
    const res = await post({ name: "stolen-cookie", scope: "full", expiresInDays: null, password: "not-it" });
    // 400, not 401: the client treats 401 as its own session having ended.
    expect(res.status).toBe(400);
    expect((await ApiKeyStore.listFor(userId)).length).toBe(before);
  });

  test("no password at all is a 422", async () => {
    expect((await post({ name: "x", scope: "read", expiresInDays: null })).status).toBe(422);
  });
});

// Last in the file: it changes this user's password and so ends the cookie above.
describe("a password change", () => {
  test("revokes every API key the user holds", async () => {
    await db.delete(apiKeys).where(eq(apiKeys.userId, userId));
    const { key } = await mint("read", "before-password-change");
    expect((await request("/api/me", { headers: bearer(key) })).status).toBe(200);

    const res = await request("/api/auth/password", {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ currentPassword: password, newPassword: "keys-password-2" }),
    });
    expect(res.status).toBe(200);

    expect((await request("/api/me", { headers: bearer(key) })).status).toBe(401);
    expect(await ApiKeyStore.listFor(userId)).toEqual([]);
  });
});
