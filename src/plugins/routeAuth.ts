import { Elysia, t } from "elysia";
import type { Cookie } from "elysia";
import { jwt } from "@elysiajs/jwt";
import { config } from "../config";
import { UserStore } from "../stores/user-store";
import { SettingsStore } from "../stores/settings-store";
import { bins } from "../lib/commands";
import {
  usernameField,
  passwordField,
  validateUsername,
  validatePassword,
} from "../constants/auth";

const MAX_AGE = 7 * 24 * 60 * 60; // 7 days in seconds
const DOCKER_TIMEOUT_MS = 30_000;

async function runWithTimeout(proc: ReturnType<typeof Bun.spawn>, ms: number): Promise<number> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { proc.kill(); reject(new Error("timed out")); }, ms);
  });
  try {
    const code = await Promise.race([proc.exited, timeout]);
    clearTimeout(timer!);
    return code;
  } catch (e) {
    clearTimeout(timer!);
    throw e;
  }
}

type JwtCtx = { verify: (token: string) => Promise<Record<string, unknown> | false> };

/**
 * Verifies the session cookie and checks tokenVersion against the DB.
 * Returns the user row on success, null if the session is missing, invalid,
 * expired, or stale (pre-rotation token after a password change).
 */
async function requireActiveSession(jwtCtx: JwtCtx, token: string | undefined) {
  if (!token) return null;
  const payload = await jwtCtx.verify(token);
  if (!payload) return null;
  const userId = parseInt(String(payload.sub), 10);
  if (isNaN(userId)) return null;
  const user = await UserStore.findById(userId);
  if (!user) return null;
  if ((payload.tokenVersion as number) !== user.tokenVersion) return null;
  return user;
}

/**
 * Wraps a Docker Hub route handler with the active-session guard.
 * Returns 401 immediately when the session is missing or stale;
 * otherwise delegates to the inner handler.
 */
async function withDockerHubAuth<T>(
  jwtCtx: JwtCtx,
  token: string | undefined,
  set: { status?: number | string },
  handler: () => Promise<T>,
): Promise<T | { error: string }> {
  if (!(await requireActiveSession(jwtCtx, token))) {
    set.status = 401;
    return { error: "Not authenticated" };
  }
  return handler();
}

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
          tokenVersion: user.tokenVersion ?? 0,
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
          tokenVersion: user.tokenVersion ?? 0,
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
    })

    // ── Docker Hub auth ───────────────────────────────────────────────────────

    .get("/dockerhub", ({ jwt: jwtCtx, cookie: { anpan_session }, set }) => {
      if (!bins.docker) { set.status = 503; return Promise.resolve({ error: "Docker is not available on this system" }); }
      return withDockerHubAuth(jwtCtx, anpan_session.value, set, async () => {
        const username = await SettingsStore.get("dockerhub_username");
        return { loggedIn: !!username, username: username ?? null };
      });
    })

    .post(
      "/dockerhub",
      ({ body, jwt: jwtCtx, cookie: { anpan_session }, set }) => {
        if (!bins.docker) { set.status = 503; return Promise.resolve({ error: "Docker is not available on this system" }); }
        const docker = bins.docker;
        return withDockerHubAuth(jwtCtx, anpan_session.value, set, async () => {
          const proc = Bun.spawn(
            [docker, "login", "--username", body.username, "--password-stdin"],
            { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
          );
          proc.stdin.write(body.password);
          proc.stdin.end();

          let loginCode: number;
          try {
            loginCode = await runWithTimeout(proc, DOCKER_TIMEOUT_MS);
          } catch {
            set.status = 500;
            return { error: "Docker login timed out" };
          }

          if (loginCode !== 0) {
            const stderr = await new Response(proc.stderr).text();
            set.status = 400;
            return { error: stderr.trim() || "docker login failed" };
          }

          await SettingsStore.set("dockerhub_username", body.username);
          return { ok: true };
        });
      },
      {
        body: t.Object({
          username: t.String({ minLength: 1 }),
          password: t.String({ minLength: 1 }),
        }),
      },
    )

    .delete("/dockerhub", ({ jwt: jwtCtx, cookie: { anpan_session }, set }) => {
      if (!bins.docker) { set.status = 503; return Promise.resolve({ error: "Docker is not available on this system" }); }
      const docker = bins.docker;
      return withDockerHubAuth(jwtCtx, anpan_session.value, set, async () => {
        const proc = Bun.spawn([docker, "logout"], { stdout: "pipe", stderr: "pipe" });
        let logoutCode: number;
        try {
          logoutCode = await runWithTimeout(proc, DOCKER_TIMEOUT_MS);
        } catch {
          set.status = 500;
          return { error: "Docker logout timed out" };
        }
        if (logoutCode !== 0) { set.status = 500; return { error: "Docker logout failed" }; }

        await SettingsStore.set("dockerhub_username", "");
        return { ok: true };
      });
    })

    .put(
      "/password",
      async ({ body, jwt: jwtCtx, cookie: { anpan_session }, set }) => {
        const token = anpan_session.value;
        const payload = token ? await jwtCtx.verify(token) : null;
        if (!payload) { set.status = 401; return { error: "Not authenticated" }; }

        const userId = parseInt(String(payload.sub), 10);
        const user   = await UserStore.findById(userId);
        if (!user)                                           { set.status = 401; return { error: "User not found" }; }
        if (payload.tokenVersion !== user.tokenVersion)     { set.status = 401; return { error: "Session expired" }; }

        const pErr = validatePassword(body.newPassword);
        if (pErr)   { set.status = 422; return { error: pErr }; }

        if (!(await UserStore.verifyPassword(user, body.currentPassword))) {
          set.status = 400;
          return { error: "Current password is incorrect" };
        }

        const hash = await Bun.password.hash(body.newPassword);
        await UserStore.updatePassword(user.id, hash);

        // Re-fetch to get the incremented tokenVersion, then issue a fresh JWT
        // so the browser immediately holds a valid session.
        const updated = await UserStore.findById(user.id);
        if (updated) {
          const newToken = await jwtCtx.sign({
            sub: String(updated.id),
            username: updated.username,
            tokenVersion: updated.tokenVersion ?? 0,
          });
          setSession(anpan_session, newToken);
        }

        return { ok: true };
      },
      {
        body: t.Object({
          currentPassword: t.String({ minLength: 1 }),
          newPassword:     passwordField,
        }),
      },
    );
}
