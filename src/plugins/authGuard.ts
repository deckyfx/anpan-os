import { Elysia, t, status } from "elysia";
import { jwt } from "@elysiajs/jwt";
import { verifySession } from "../lib/session-auth";
import { originGuard } from "./originGuard";

/**
 * Auth guard factory — derives context with `user` (sub + username) from the
 * session cookie.  Yields 401 unless the session verifies in full: signature, user,
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
    .resolve(async ({ jwt: jwtCtx, cookie: { anpan_session } }) => {
      // Signature, user, tokenVersion and a live session row -- see verifySession.
      const session = await verifySession(jwtCtx, anpan_session.value);
      if (!session) return status(401, "Unauthorized");

      return {
        user: {
          sub:      String(session.user.id),
          username: session.user.username,
        },
      };
    })
    .as("scoped");
}
