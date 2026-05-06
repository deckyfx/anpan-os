/**
 * Auth flow integration tests — uses Eden Treaty against a live Elysia app
 * instance (no network, no running server required).
 *
 * Run: bun test --bail tests/auth.test.ts
 */
import { describe, test, expect, beforeAll } from "bun:test";
import { UserStore } from "../src/stores/user-store";
import { createTestClient, extractCookie } from "./helpers";

const client = createTestClient();

// Shared state across sequential tests (run in declaration order within describe).
let sessionCookie = "";
let capturedJwt   = ""; // raw JWT value — used to probe Bearer auth after logout

beforeAll(async () => {
  await UserStore.deleteAll();
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("auth flow", () => {

  // 1. Fresh state ─────────────────────────────────────────────────────────────

  test("GET /api/auth/status — not initialized after user reset", async () => {
    const { data, response } = await client.api.auth.status.get();

    expect(response.status).toBe(200);
    const body = data as { initialized: boolean; authenticated: boolean } | null;
    expect(body?.initialized).toBe(false);
    expect(body?.authenticated).toBe(false);
  });

  // 2. Setup ───────────────────────────────────────────────────────────────────

  test("POST /api/auth/setup — creates admin, returns session cookie", async () => {
    const { data, response } = await client.api.auth.setup.post({
      username: "admin",
      password: "password123",
    });

    expect(response.status).toBe(200);
    const body = data as { ok: boolean; username: string } | null;
    expect(body?.ok).toBe(true);
    expect(body?.username).toBe("admin");

    ({ cookie: sessionCookie, jwt: capturedJwt } = extractCookie(response));
  });

  test("POST /api/auth/setup — 403 when admin already exists", async () => {
    const { response } = await client.api.auth.setup.post({
      username: "other",
      password: "password123",
    });
    expect(response.status).toBe(403);
  });

  // 3. Authenticated state ──────────────────────────────────────────────────────

  test("GET /api/auth/status — initialized and authenticated with session cookie", async () => {
    const { data, response } = await client.api.auth.status.get({
      headers: { Cookie: sessionCookie },
    });

    expect(response.status).toBe(200);
    const body = data as { initialized: boolean; authenticated: boolean } | null;
    expect(body?.initialized).toBe(true);
    expect(body?.authenticated).toBe(true);
  });

  test("GET /api/me — guarded route returns user info", async () => {
    const { data, response } = await client.api.me.get({
      headers: { Cookie: sessionCookie },
    });

    expect(response.status).toBe(200);
    const body = data as { sub: string; username: string } | null;
    expect(body?.username).toBe("admin");
    expect(typeof body?.sub).toBe("string");
  });

  // 4. Logout ──────────────────────────────────────────────────────────────────

  test("POST /api/auth/logout — clears session", async () => {
    const { data, response } = await client.api.auth.logout.post(undefined as never, {
      headers: { Cookie: sessionCookie },
    });

    expect(response.status).toBe(200);
    const body = data as { ok: boolean } | null;
    expect(body?.ok).toBe(true);

    sessionCookie = "";
  });

  // 5. Post-logout: guarded route must reject ──────────────────────────────────

  test("GET /api/me — 401 with no cookie after logout", async () => {
    const { response } = await client.api.me.get();
    expect(response.status).toBe(401);
  });

  test("GET /api/me — 401 with Bearer token after logout (guard is cookie-only)", async () => {
    // The JWT is still cryptographically valid, but the auth guard reads only the
    // session cookie. Passing the same token via Authorization header must still fail.
    const { response } = await client.api.me.get({
      headers: { Authorization: `Bearer ${capturedJwt}` },
    });
    expect(response.status).toBe(401);
  });

  // 6. Login ───────────────────────────────────────────────────────────────────

  test("POST /api/auth/login — 401 with wrong password", async () => {
    const { response } = await client.api.auth.login.post({
      username: "admin",
      password: "wrongpassword",
    });
    expect(response.status).toBe(401);
  });

  test("POST /api/auth/login — success with correct credentials", async () => {
    const { data, response } = await client.api.auth.login.post({
      username: "admin",
      password: "password123",
    });

    expect(response.status).toBe(200);
    const body = data as { ok: boolean; username: string } | null;
    expect(body?.ok).toBe(true);
    expect(body?.username).toBe("admin");

    ({ cookie: sessionCookie } = extractCookie(response));
  });

  test("GET /api/me — guarded route works after re-login", async () => {
    const { data, response } = await client.api.me.get({
      headers: { Cookie: sessionCookie },
    });

    expect(response.status).toBe(200);
    const body = data as { sub: string; username: string } | null;
    expect(body?.username).toBe("admin");
    expect(typeof body?.sub).toBe("string");
  });

});
