import { Elysia, t, status } from "elysia";
import { jwt } from "@elysiajs/jwt";
import { verifySession } from "../lib/session-auth";
import { bearerCredential, noteApiKeyUse, verifyApiKey } from "../lib/api-key-auth";
import type { ApiKeyIdentity } from "../lib/api-key-auth";
import { keyMayAccess } from "../lib/api-key-scope";
import type { ApiKeyScope } from "../lib/api-key-scope";
import { originGuard } from "./originGuard";

/** The address of the connection itself, or null where there is none (in-process tests). */
function connectionAddress(
  server: { requestIP(request: Request): { address: string } | null } | null,
  request: Request,
): string | null {
  // The socket's address, never X-Forwarded-For: that header is whatever the client wrote,
  // and a key's last-used address is only worth showing if the key's holder cannot pick it.
  return server?.requestIP(request)?.address ?? null;
}

/**
 * Auth guard factory — derives context with `user` (sub + username) from either an API key
 * (`Authorization: Bearer anpan_…`) or the session cookie, and `apiKey` naming the key, or
 * null for a browser session.
 *
 * A request that presents a Bearer credential is judged by it alone: an invalid, expired or
 * unknown key is a 401 even when a valid cookie rides along. Falling back would let a key's
 * failure — or its scope — be papered over by whatever session the same client also holds.
 * A valid key whose scope does not cover the request is a 403; see lib/api-key-scope.
 *
 * The cookie path is unchanged: 401 unless the session verifies in full — signature, user,
 * tokenVersion, and a session row that has not been logged out.
 *
 * Usage:
 *   new Elysia()
 *     .use(authGuard(jwtSecret))
 *     .get("/protected", ({ user }) => ({ hello: user.username }))
 */
export function authGuard(jwtSecret: string) {
  return new Elysia({ name: "auth-guard" })
    // Cross-site refusal first, so a forged request is turned away whoever's cookie it has.
    .use(originGuard())
    .use(jwt({ name: "jwt", secret: jwtSecret, exp: "7d" }))
    .guard({
      cookie: t.Cookie({
        anpan_session: t.Optional(t.String()),
      }),
    })
    .resolve(async ({ jwt: jwtCtx, cookie: { anpan_session }, request, server, set }) => {
      const bearer = bearerCredential(request);
      if (bearer !== null) {
        const found = await verifyApiKey(bearer);
        if (!found) {
          set.headers["www-authenticate"] = 'Bearer realm="anpan-os"';
          return status(401, { error: "Invalid or expired API key" });
        }

        const { key, user } = found;
        const method = request.method.toUpperCase();
        const path = new URL(request.url).pathname;
        const isRead = method === "GET" || method === "HEAD";
        if (!keyMayAccess(key.scope, method, path)) {
          if (!isRead) console.log(`[api-key] ${key.name} (${key.id}) ${method} ${path} — refused by scope`);
          return status(403, { error: `This API key's scope (${key.scope}) does not allow ${method} ${path}` });
        }

        await noteApiKeyUse(key.id, connectionAddress(server, request));
        // Writes only: reads would drown the log, and a write is what someone later asks
        // "which agent did that?" about.
        if (!isRead) console.log(`[api-key] ${key.name} (${key.id}) ${method} ${path}`);

        const apiKey: ApiKeyIdentity = { id: key.id, name: key.name, scope: key.scope as ApiKeyScope };
        return { user: { sub: String(user.id), username: user.username }, apiKey };
      }

      // Signature, user, tokenVersion and a live session row -- see verifySession.
      const session = await verifySession(jwtCtx, anpan_session.value);
      if (!session) return status(401, "Unauthorized");

      return {
        user: {
          sub:      String(session.user.id),
          username: session.user.username,
        },
        apiKey: null as ApiKeyIdentity | null,
      };
    })
    .as("scoped");
}
