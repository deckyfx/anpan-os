import type { Cookie } from "elysia";
import { config } from "../config";
import { UserStore } from "../stores/user-store";
import { SessionStore, SESSION_MAX_AGE_S } from "../stores/session-store";
import type { User } from "../db/schema";

/**
 * Verifying and issuing browser sessions, in one place.
 *
 * Before this, a session was checked in four places with three different rules, one of
 * which — /api/auth/status — checked the signature alone, so after a password change it
 * still reported "signed in" while every other route refused the token. And the cookie was
 * written by two copies of the same function. Every check and every issue now goes through
 * here, so they cannot drift apart again.
 */

/** The JWT plugin's context as route handlers receive it. Method syntax keeps it assignable. */
export interface JwtCtx {
  sign(payload: Record<string, string | number>): Promise<string>;
  verify(token: string): Promise<Record<string, unknown> | false>;
}

/** The session cookie, as both auth plugins expose it. */
type SessionCookie = Pick<Cookie<string | undefined>, "value" | "httpOnly" | "sameSite" | "secure" | "maxAge" | "path">;

/** A verified session: whose it is, and which one, so it can be ended. */
export interface ActiveSession {
  user: User;
  sid: string;
}

/**
 * Resolve a session token to its user and session, or null.
 *
 * Every check a session must pass: the JWT verifies, its user exists, its tokenVersion is
 * current — a password change ends every session — and the session row it names is still
 * live, which is how a logout ends this device's session and no other.
 *
 * A token without a session id predates per-device sessions and is refused. Every browser is
 * signed out once after upgrading; accepting them instead would leave each one unrevocable
 * for up to a week.
 */
export async function verifySession(jwtCtx: JwtCtx, token: string | undefined): Promise<ActiveSession | null> {
  if (!token) return null;
  const payload = await jwtCtx.verify(token);
  if (!payload) return null;

  const userId = Number.parseInt(String(payload.sub), 10);
  const sid = typeof payload.sid === "string" ? payload.sid : null;
  if (Number.isNaN(userId) || !sid) return null;

  const user = await UserStore.findById(userId);
  if (!user || payload.tokenVersion !== (user.tokenVersion ?? 0)) return null;
  if (!(await SessionStore.isActive(sid, userId))) return null;
  return { user, sid };
}

/** Start a session for `user` in this browser: record it, sign it, and set the cookie. */
export async function issueSession(
  jwtCtx: JwtCtx,
  cookie: SessionCookie,
  user: User,
  request: Request,
): Promise<void> {
  const sid = await SessionStore.create(user.id);
  const token = await jwtCtx.sign({
    sub: String(user.id),
    username: user.username,
    tokenVersion: user.tokenVersion ?? 0,
    sid,
  });
  setSessionCookie(cookie, token, request);
}

/**
 * The session id a token names, if its signature verifies — whether or not the session is
 * still live. Logout uses it: ending a session must not depend on that session being valid.
 */
export async function sessionIdOf(jwtCtx: JwtCtx, token: string | undefined): Promise<string | null> {
  if (!token) return null;
  const payload = await jwtCtx.verify(token);
  return payload && typeof payload.sid === "string" ? payload.sid : null;
}

/**
 * Writes the JWT session cookie with the project's standard security attributes.
 *
 * The `Secure` flag is derived from the *client-facing* protocol, not the backend TLS
 * config. When anpan-os runs behind a reverse proxy that terminates TLS (e.g. Nginx
 * Proxy Manager), the browser talks HTTP to the proxy while the backend sees HTTPS.
 * Setting `Secure` based on backend TLS would cause browsers to silently drop the
 * cookie on HTTP responses from the proxy.
 *
 * Resolution order:
 *   1. `X-Forwarded-Proto: https` → `Secure` (proxy is terminating TLS for the client)
 *   2. `X-Forwarded-Proto: http`  → not `Secure`
 *   3. No `X-Forwarded-Proto` header → fall back to `config.tlsEnabled` (direct connection)
 */
function setSessionCookie(c: SessionCookie, token: string, request: Request): void {
  const forwarded = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  c.value    = token;
  c.httpOnly = true;
  c.sameSite = config.sessionSameSite;
  c.secure   = forwarded ? forwarded === "https" : config.tlsEnabled;
  c.maxAge   = SESSION_MAX_AGE_S;
  c.path     = "/";
}
