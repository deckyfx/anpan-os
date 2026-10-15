import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { Elysia } from "elysia";
import { jwt } from "@elysiajs/jwt";
import { eq } from "drizzle-orm";
import { createApp } from "../src/app";
import { db } from "../src/db/index";
import { users } from "../src/db/schema";
import { UserStore } from "../src/stores/user-store";
import { SessionStore } from "../src/stores/session-store";
import { TEST_JWT, extractCookie } from "./helpers";

/**
 * Each browser holds its own session. Logging out used to delete only the cookie, so a copy
 * of the token stayed valid for up to a week, and /api/auth/status checked the signature
 * alone, so it reported "signed in" after a password change while every route refused the
 * token. These drive the real app, signed in as several browsers at once.
 *
 * A throwaway user keeps the password change from touching the shared admin account that
 * other test files sign in with.
 */

const app = createApp(TEST_JWT);
const username = `session-${crypto.randomUUID().slice(0, 8)}`;
let password = "first-password-1";

beforeAll(async () => { await UserStore.create(username, password); });
afterAll(async () => { await db.delete(users).where(eq(users.username, username)); });

const request = (path: string, init: RequestInit = {}) =>
  app.handle(new Request(`http://localhost${path}`, init));

/** Sign in as a separate browser would, returning that browser's session cookie. */
async function signIn(): Promise<string> {
  const res = await request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  expect(res.status).toBe(200);
  return extractCookie(res).cookie;
}

/** The status a protected route gives this cookie. */
const protectedStatus = async (cookie: string) =>
  (await request("/api/system/info", { headers: { cookie } })).status;

/** Whether /api/auth/status believes this cookie is signed in. */
const statusSaysSignedIn = async (cookie: string) =>
  ((await (await request("/api/auth/status", { headers: { cookie } })).json()) as { authenticated: boolean })
    .authenticated;

/** Sign a token the way the app does, with whatever claims a test needs. */
async function mint(claims: Record<string, string | number>): Promise<string> {
  const minter = new Elysia()
    .use(jwt({ name: "jwt", secret: TEST_JWT, exp: "7d" }))
    .get("/mint", ({ jwt: j }) => j.sign(claims));
  return (await minter.handle(new Request("http://localhost/mint"))).text();
}

describe("per-device sessions", () => {
  test("logging out ends this browser's session and leaves another's alone", async () => {
    const laptop = await signIn();
    const phone  = await signIn();
    expect(await protectedStatus(laptop)).toBe(200);
    expect(await protectedStatus(phone)).toBe(200);

    expect((await request("/api/auth/logout", { method: "POST", headers: { cookie: laptop } })).status).toBe(200);

    // `laptop` is now exactly what a copy of the token would be. It must be refused —
    // before, only the cookie was deleted, and the token itself stayed valid for a week.
    expect(await protectedStatus(laptop)).toBe(401);
    expect(await statusSaysSignedIn(laptop)).toBe(false);

    expect(await protectedStatus(phone)).toBe(200);
    expect(await statusSaysSignedIn(phone)).toBe(true);
  });

  test("a password change ends other sessions, keeps this one, and /status agrees", async () => {
    const laptop = await signIn();
    const phone  = await signIn();

    const res = await request("/api/auth/password", {
      method: "PUT",
      headers: { cookie: laptop, "content-type": "application/json" },
      body: JSON.stringify({ currentPassword: password, newPassword: "second-password-2" }),
    });
    expect(res.status).toBe(200);
    password = "second-password-2";
    const laptopAfter = extractCookie(res).cookie;

    // /status checked the signature alone and still said "signed in" here.
    expect(await statusSaysSignedIn(phone)).toBe(false);
    expect(await protectedStatus(phone)).toBe(401);
    expect(await protectedStatus(laptop)).toBe(401);          // the old token, even on this device

    expect(await protectedStatus(laptopAfter)).toBe(200);
    expect(await statusSaysSignedIn(laptopAfter)).toBe(true);
  });

  test("a token from before per-device sessions is refused; the same token with a session works", async () => {
    const user = await UserStore.findByUsername(username);
    if (!user) throw new Error("test user missing");
    const base = { sub: String(user.id), username, tokenVersion: user.tokenVersion ?? 0 };

    // The positive control proves the minting is sound, so the refusal below is about the
    // missing session id and nothing else.
    const sid = await SessionStore.create(user.id);
    expect(await protectedStatus(`anpan_session=${await mint({ ...base, sid })}`)).toBe(200);

    const legacy = `anpan_session=${await mint(base)}`;
    expect(await protectedStatus(legacy)).toBe(401);
    expect(await statusSaysSignedIn(legacy)).toBe(false);
  });

  test("logging out with a token that no longer verifies still clears the cookie", async () => {
    const res = await request("/api/auth/logout", { method: "POST", headers: { cookie: "anpan_session=not-a-jwt" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie") ?? "").toContain("anpan_session=");
  });
});
