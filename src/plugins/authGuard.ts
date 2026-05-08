import { Elysia, t } from "elysia";
import { jwt } from "@elysiajs/jwt";
import { UserStore } from "../stores/user-store";

/**
 * Auth guard factory — derives context with `user` (sub + username) from the
 * session cookie.  Yields 401 when the cookie is missing or the JWT is invalid.
 *
 * Usage:
 *   new Elysia()
 *     .use(authGuard(jwtSecret))
 *     .get("/protected", ({ user }) => ({ hello: user.username }))
 */
export function authGuard(jwtSecret: string) {
  return new Elysia({ name: "auth-guard" })
    .use(jwt({ name: "jwt", secret: jwtSecret, exp: "7d" }))
    .guard({
      cookie: t.Cookie({
        anpan_session: t.Optional(t.String()),
      }),
    })
    .resolve(async ({ jwt: jwtCtx, cookie: { anpan_session }, set }) => {
      const token = anpan_session.value;
      if (!token) {
        set.status = 401;
        throw new Error("Unauthorized");
      }

      const payload = await jwtCtx.verify(token);
      if (!payload) {
        set.status = 401;
        throw new Error("Unauthorized");
      }

      // Verify tokenVersion to invalidate old JWTs after password change
      const userId = parseInt(String(payload.sub), 10);
      const user = await UserStore.findById(userId);
      if (!user || (payload.tokenVersion !== user.tokenVersion)) {
        set.status = 401;
        throw new Error("Unauthorized");
      }

      return {
        user: {
          sub:      payload.sub as string,
          username: payload.username as string,
        },
      };
    })
    .as("scoped");
}
