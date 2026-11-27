import { Elysia, t, status } from "elysia";
import { jwt } from "@elysiajs/jwt";
import { verifySession } from "../lib/session-auth";
import { bearerCredential, forgetApiKeyUse, generateApiKeyToken } from "../lib/api-key-auth";
import { API_KEY_SCOPES } from "../lib/api-key-scope";
import { ApiKeyLimitError, ApiKeyStore } from "../stores/api-key-store";
import type { ApiKey } from "../db/schema";
import { originGuard } from "./originGuard";
import { LoginThrottle } from "../lib/login-throttle";
import { UserStore } from "../stores/user-store";

/**
 * Wrong password guesses when creating a key, per session. Keyed on the session for the
 * same reason as the password-change form: keyed on the user, a thief's guesses would also
 * lock the owner out.
 */
const createThrottle = new LoginThrottle();

const cookieSchema = t.Cookie({ anpan_session: t.Optional(t.String()) });

const errorSchema = t.Object({ error: t.String() });

// Spelled out, not mapped from API_KEY_SCOPES: TypeBox needs the literal tuple to infer the
// union, and a mapped array widens to never. The assignment below fails to compile if
// API_KEY_SCOPES gains a scope this schema does not list.
const scopeSchema = t.Union([t.Literal("read"), t.Literal("operate"), t.Literal("full")]);
const _scopesInStep: readonly (typeof scopeSchema.static)[] = API_KEY_SCOPES;

/** A key as the list shows it. Never the hash: it is useless to the UI and useful to no one. */
const apiKeySchema = t.Object({
  id:         t.String(),
  name:       t.String(),
  scope:      scopeSchema,
  createdAt:  t.String({ format: "date-time" }),
  expiresAt:  t.Union([t.String({ format: "date-time" }), t.Null()]),
  lastUsedAt: t.Union([t.String({ format: "date-time" }), t.Null()]),
  lastUsedIp: t.Union([t.String(), t.Null()]),
});

type ApiKeyView = typeof apiKeySchema.static;

function toView(k: ApiKey): ApiKeyView {
  return {
    id:         k.id,
    name:       k.name,
    scope:      k.scope as ApiKeyView["scope"],
    createdAt:  k.createdAt.toISOString(),
    expiresAt:  k.expiresAt?.toISOString() ?? null,
    lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
    lastUsedIp: k.lastUsedIp ?? null,
  };
}

/** Control characters would let a key's name forge lines in the `[api-key]` audit log. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * API-key management.
 *
 * Routes — all under /api/api-keys, browser session only:
 *   GET    /       → { keys }            — the caller's keys, newest first
 *   POST   /       → { key, apiKey }     — mint a key; `key` is the token, shown this once.
 *                                           Needs the current password; a password change
 *                                           revokes every key.
 *   DELETE /:id    → { ok: true }        — revoke one of the caller's keys
 *
 * Deliberately not behind authGuard, which accepts keys: a leaked key that could mint more
 * keys could never be fully revoked. Any Bearer credential is refused here outright, even
 * beside a valid cookie, so that rule does not depend on the scope table alone.
 */
export function apiKeysPlugin(jwtSecret: string) {
  return new Elysia({ prefix: "/api/api-keys" })
    .use(originGuard())
    .use(jwt({ name: "jwt", secret: jwtSecret, exp: "7d" }))
    .guard({ cookie: cookieSchema })
    .resolve(async ({ jwt: jwtCtx, cookie: { anpan_session }, request }) => {
      if (bearerCredential(request) !== null) {
        return status(403, { error: "API keys cannot manage API keys — sign in to the web UI" });
      }
      const session = await verifySession(jwtCtx, anpan_session.value);
      if (!session) return status(401, { error: "Not authenticated" });
      return { owner: session.user, sid: session.sid };
    })

    .get("/", async ({ owner }) => ({
      keys: (await ApiKeyStore.listFor(owner.id)).map(toView),
    }), {
      response: { 200: t.Object({ keys: t.Array(apiKeySchema) }), 401: errorSchema, 403: errorSchema },
    })

    .post("/", async ({ owner, sid, body, set }) => {
      const name = body.name.trim();
      if (name.length === 0) return status(422, { error: "Name is required" });
      if (CONTROL_CHARS.test(name)) return status(422, { error: "Name must not contain control characters" });

      // The current password, not just the session: a key outlives a session, so a stolen
      // cookie must not be enough to turn into lasting access. 400, not 401, which the client
      // would read as its session having ended.
      const throttleKey = `api-key|${sid}`;
      const wait = createThrottle.acquire(throttleKey);
      if (wait > 0) {
        const seconds = Math.ceil(wait / 1000);
        set.headers["retry-after"] = String(seconds);
        return status(429, { error: `Too many failed attempts — try again in ${seconds} s` });
      }
      try {
        if (!(await UserStore.verifyPassword(owner, body.password))) {
          createThrottle.recordFailure(throttleKey);
          return status(400, { error: "Current password is incorrect" });
        }
        createThrottle.recordSuccess(throttleKey);
      } finally {
        createThrottle.release(throttleKey);
      }

      const { id, token, secretHash } = generateApiKeyToken();
      const expiresAt = body.expiresInDays === null
        ? null
        : new Date(Date.now() + body.expiresInDays * 24 * 60 * 60 * 1000);
      try {
        const created = ApiKeyStore.create({ id, userId: owner.id, name, scope: body.scope, secretHash, expiresAt });
        return { key: token, apiKey: toView(created) };
      } catch (err) {
        if (err instanceof ApiKeyLimitError) return status(409, { error: err.message });
        throw err;
      }
    }, {
      body: t.Object({
        // 64 before trimming as well as after, so a name padded with spaces cannot be large.
        name:          t.String({ minLength: 1, maxLength: 64 }),
        scope:         scopeSchema,
        expiresInDays: t.Union([t.Integer({ minimum: 1, maximum: 3650 }), t.Null()]),
        /** The account's current password, confirmed on every key creation. */
        password:      t.String({ minLength: 1 }),
      }),
      response: {
        200: t.Object({ key: t.String(), apiKey: apiKeySchema }),
        400: errorSchema, 401: errorSchema, 403: errorSchema, 409: errorSchema, 422: errorSchema, 429: errorSchema,
      },
    })

    .delete("/:id", async ({ owner, params }) => {
      if (!(await ApiKeyStore.delete(params.id, owner.id))) return status(404, { error: "API key not found" });
      forgetApiKeyUse(params.id);
      return { ok: true as const };
    }, {
      params: t.Object({ id: t.String({ pattern: "^[0-9a-f]{12}$" }) }),
      response: { 200: t.Object({ ok: t.Literal(true) }), 401: errorSchema, 403: errorSchema, 404: errorSchema },
    });
}
