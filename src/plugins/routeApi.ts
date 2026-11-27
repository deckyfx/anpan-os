import { Elysia } from "elysia";
import { authGuard } from "./authGuard";
import { UserStore } from "../stores/user-store";
import { avatarUrlOf } from "../lib/avatar";

/**
 * Protected API routes — all routes in this plugin require a valid session or API key.
 *
 * Routes:
 *   GET  /api/me  — { sub, username, avatarUrl }
 */
export function apiPlugin(jwtSecret: string) {
  return new Elysia({ prefix: "/api" })
    .use(authGuard(jwtSecret))
    .get("/me", async ({ user }) => {
      const row = await UserStore.findById(Number(user.sub));
      return { sub: user.sub, username: user.username, avatarUrl: row ? avatarUrlOf(row) : null };
    });
}
