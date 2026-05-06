import { Elysia, t } from "elysia";
import type { Cookie } from "elysia";
import { jwt } from "@elysiajs/jwt";
import { config } from "../config";
import { UserStore } from "../stores/user-store";
import {
  usernameField,
  passwordField,
  validateUsername,
  validatePassword,
} from "../constants/auth";

const MAX_AGE = 7 * 24 * 60 * 60; // 7 days in seconds

/** Cookie schema — session value is a JWT string. */
const cookieSchema = t.Cookie({
  anpan_session: t.Optional(t.String()),
});

function setSession(c: Cookie<string | undefined>, token: string) {
  c.value = token;
  c.httpOnly = true;
  c.sameSite = "strict";
  c.secure = config.tlsEnabled;
  c.maxAge = MAX_AGE;
  c.path = "/";
}

/** Returns a 422 JSON response with an `error` field, or null if valid. */
function checkCredentials(
  username: string,
  password: string,
  strictPassword = false,
): Response | null {
  const uErr = validateUsername(username);
  if (uErr) return Response.json({ error: uErr }, { status: 422 });
  if (strictPassword) {
    const pErr = validatePassword(password);
    if (pErr) return Response.json({ error: pErr }, { status: 422 });
  } else if (!password) {
    return Response.json({ error: "Password is required" }, { status: 422 });
  }
  return null;
}

/**
 * Auth plugin factory — requires the JWT secret resolved at startup.
 *
 * Routes:
 *   GET  /api/auth/status  — { initialized, authenticated }
 *   POST /api/auth/setup   — create admin (only when no users exist)
 *   POST /api/auth/login   — verify credentials, set JWT session cookie
 *   POST /api/auth/logout  — clear session cookie
 */
export function authPlugin(jwtSecret: string) {
  return new Elysia({ prefix: "/api/auth" })
    .use(jwt({ name: "jwt", secret: jwtSecret, exp: "7d" }))
    .guard({ cookie: cookieSchema })

    .get("/status", async ({ jwt: jwtCtx, cookie: { anpan_session } }) => {
      const initialized = (await UserStore.count()) > 0;
      const token = anpan_session.value;
      const authenticated = token ? !!(await jwtCtx.verify(token)) : false;
      return { initialized, authenticated };
    })

    .post(
      "/setup",
      async ({ body, jwt: jwtCtx, cookie: { anpan_session }, set }) => {
        const invalid = checkCredentials(body.username, body.password, true);
        if (invalid) return invalid;

        if ((await UserStore.count()) > 0) {
          set.status = 403;
          return { error: "Admin user already exists" };
        }

        const user = await UserStore.create(body.username, body.password);
        const token = await jwtCtx.sign({
          sub: String(user.id),
          username: user.username,
        });
        setSession(anpan_session, token);
        return { ok: true, username: user.username };
      },
      {
        body: t.Object({
          username: usernameField,
          password: passwordField,
        }),
      },
    )

    .post(
      "/login",
      async ({ body, jwt: jwtCtx, cookie: { anpan_session }, set }) => {
        // Validate before hitting the DB — usernameField/passwordField use minLength:1
        // so TypeBox already rejects missing fields; this catches empty-string values
        // and returns a message that names the specific field.
        const invalid = checkCredentials(body.username, body.password);
        if (invalid) return invalid;

        if ((await UserStore.count()) === 0) {
          set.status = 403;
          return { error: "No admin configured — run setup first" };
        }

        const user = await UserStore.findByUsername(body.username);
        if (!user || !(await UserStore.verifyPassword(user, body.password))) {
          set.status = 401;
          return { error: "Invalid credentials" };
        }

        const token = await jwtCtx.sign({
          sub: String(user.id),
          username: user.username,
        });
        setSession(anpan_session, token);
        return { ok: true, username: user.username };
      },
      {
        body: t.Object({
          username: usernameField,
          password: passwordField,
        }),
      },
    )

    .post("/logout", ({ cookie: { anpan_session } }) => {
      anpan_session.remove();
      return { ok: true };
    });
}
