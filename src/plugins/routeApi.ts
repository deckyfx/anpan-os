import { Elysia } from "elysia";
import { authGuard } from "./authGuard";

/**
 * Protected API routes — all routes in this plugin require a valid session.
 *
 * Routes:
 *   GET  /api/me  — { sub, username }
 */
export function apiPlugin(jwtSecret: string) {
  return new Elysia({ prefix: "/api" })
    .use(authGuard(jwtSecret))
    .get("/me", ({ user }) => ({ sub: user.sub, username: user.username }));
}
