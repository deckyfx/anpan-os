import { Elysia, t } from "elysia";
import { jwt } from "@elysiajs/jwt";
import { config } from "../config";
import { UserStore } from "../stores/user-store";
import { SettingsStore } from "../stores/settings-store";
import { commands } from "../lib/commands";
import { issueSession, sessionIdOf, verifySession } from "../lib/session-auth";
import type { JwtCtx } from "../lib/session-auth";
import { SessionStore } from "../stores/session-store";
import {
  usernameField,
  passwordField,
  validateUsername,
  validatePassword,
} from "../constants/auth";

const DOCKER_TIMEOUT_MS = 30_000;

/**
 * Races a spawned process against a timeout.
 * Kills the process and rejects if `ms` elapses before it exits.
 */
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

/** The user behind a fully verified session, or null. See verifySession. */
async function requireActiveSession(jwtCtx: JwtCtx, token: string | undefined) {
  return (await verifySession(jwtCtx, token))?.user ?? null;
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
 *   POST /api/auth/logout  — end this browser's session and clear its cookie
 */
/**
 * What the browser is told when Docker is absent.
 *
 * "not installed or not running" rather than "not available": on macOS Docker is a
 * third-party application that may simply not be there, and on both platforms the daemon
 * can be stopped. Neither is a fault the user can act on without being told which it is.
 */
const DOCKER_MISSING = "Docker is not installed or not running — see System Doctor";

/** Sets a 503 and returns true when Docker cannot be invoked. */
async function dockerMissing(set: { status?: number | string }): Promise<boolean> {
  if (await commands.isAvailable("docker")) return false;
  set.status = 503;
  return true;
}

export function authPlugin(jwtSecret: string) {
  return new Elysia({ prefix: "/api/auth" })
    .use(jwt({ name: "jwt", secret: jwtSecret, exp: "7d" }))
    .guard({ cookie: cookieSchema })

    .get("/methods", () => {
      const disabled = config.disabledLoginMethods;
      return {
        form:    !disabled.has("form"),
        passkey: !disabled.has("passkey"),
      };
    })

    .get("/status", async ({ jwt: jwtCtx, cookie: { anpan_session } }) => {
      const initialized = (await UserStore.count()) > 0;
      // The full check. Verifying the signature alone reported "signed in" for a token
      // that a password change or a logout had already ended.
      const authenticated = !!(await verifySession(jwtCtx, anpan_session.value));
      return { initialized, authenticated };
    })

    .post(
      "/setup",
      async ({ body, jwt: jwtCtx, cookie: { anpan_session }, set, request }) => {
        if (config.disabledLoginMethods.has("form")) {
          set.status = 403;
          return { error: "Form login is disabled" };
        }

        const invalid = checkCredentials(body.username, body.password, true);
        if (invalid) return invalid;

        if ((await UserStore.count()) > 0) {
          set.status = 403;
          return { error: "Admin user already exists" };
        }

        const user = await UserStore.create(body.username, body.password);
        await issueSession(jwtCtx, anpan_session, user, request);
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
      async ({ body, jwt: jwtCtx, cookie: { anpan_session }, set, request }) => {
        if (config.disabledLoginMethods.has("form")) {
          set.status = 403;
          return { error: "Form login is disabled" };
        }

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

        await issueSession(jwtCtx, anpan_session, user, request);
        return { ok: true, username: user.username };
      },
      {
        body: t.Object({
          username: usernameField,
          password: passwordField,
        }),
      },
    )

    .post("/logout", async ({ jwt: jwtCtx, cookie: { anpan_session } }) => {
      // End this browser's session on the server, so a copy of its token stops working
      // too. Deleting the cookie alone left that copy valid for up to a week. Only a
      // verified signature is needed: the id is unguessable, and ending a session must not
      // depend on the session still being valid.
      const sid = await sessionIdOf(jwtCtx, anpan_session.value);
      if (sid) await SessionStore.revoke(sid);
      anpan_session.remove();
      return { ok: true };
    })

    // ── Docker Hub auth ───────────────────────────────────────────────────────

    .get("/dockerhub", ({ jwt: jwtCtx, cookie: { anpan_session }, set }) => {
      return withDockerHubAuth(jwtCtx, anpan_session.value, set, async () => {
        if (await dockerMissing(set)) return { error: DOCKER_MISSING };
        const username = await SettingsStore.get("dockerhub_username");
        return { loggedIn: !!username, username: username ?? null };
      });
    })

    .post(
      "/dockerhub",
      ({ body, jwt: jwtCtx, cookie: { anpan_session }, set }) => {
        return withDockerHubAuth(jwtCtx, anpan_session.value, set, async () => {
          const docker = await commands.which("docker");
          if (!docker) { set.status = 503; return { error: DOCKER_MISSING }; }
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
      return withDockerHubAuth(jwtCtx, anpan_session.value, set, async () => {
        const docker = await commands.which("docker");
        if (!docker) { set.status = 503; return { error: DOCKER_MISSING }; }
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
      async ({ body, jwt: jwtCtx, cookie: { anpan_session }, set, request }) => {
        const session = await verifySession(jwtCtx, anpan_session.value);
        if (!session) { set.status = 401; return { error: "Not authenticated" }; }
        const user = session.user;

        const pErr = validatePassword(body.newPassword);
        if (pErr)   { set.status = 422; return { error: pErr }; }

        if (!(await UserStore.verifyPassword(user, body.currentPassword))) {
          set.status = 400;
          return { error: "Current password is incorrect" };
        }

        const hash = await Bun.password.hash(body.newPassword);
        await UserStore.updatePassword(user.id, hash);

        // A new password ends every session: the bumped tokenVersion already refuses their
        // tokens, and their rows go too. This browser then gets a fresh session, so the
        // user who just changed it stays signed in.
        await SessionStore.revokeAllFor(user.id);
        const updated = await UserStore.findById(user.id);
        if (updated) await issueSession(jwtCtx, anpan_session, updated, request);

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
