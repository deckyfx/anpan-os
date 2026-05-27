import { Elysia, t } from "elysia";
import { jwt } from "@elysiajs/jwt";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import type {
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
} from "@simplewebauthn/server";
import { config } from "../config";
import { authGuard } from "./authGuard";
import { UserStore } from "../stores/user-store";
import { PasskeyStore } from "../stores/passkey-store";

const RP_NAME = "anpan-os";

// ─── In-memory challenge store ────────────────────────────────────────────────
// Challenges expire after 5 minutes. Keyed by a random nonce sent to the client.

interface PendingChallenge {
  challenge: string;
  userId?:   number;   // set for registration; absent for login
  rpId:      string;
  expiresAt: number;
}

const pending = new Map<string, PendingChallenge>();

/** Remove expired challenges (called on each options request). */
function pruneExpired() {
  const now = Date.now();
  for (const [k, v] of pending) {
    if (v.expiresAt < now) pending.delete(k);
  }
}

/** Extract rpId (hostname only, no port) from an Origin header value. */
function rpIdFromOrigin(origin: string): string {
  try {
    return new URL(origin).hostname;
  } catch {
    return origin;
  }
}

/**
 * Check that the request origin is permitted.
 * If passkey_allowed_origins is empty, every origin is accepted.
 */
function originAllowed(origin: string): boolean {
  const list = config.passkeyAllowedOrigins;
  if (list.length === 0) return true;
  return list.includes(origin);
}

// ─── Cookie schema (same as authPlugin) ──────────────────────────────────────

const cookieSchema = t.Cookie({ anpan_session: t.Optional(t.String()) });

const MAX_AGE = 7 * 24 * 60 * 60;

function setSession(c: { value: string | undefined; httpOnly: boolean; sameSite: string; secure: boolean; maxAge: number; path: string }, token: string) {
  c.value    = token;
  c.httpOnly = true;
  c.sameSite = config.sessionSameSite;
  c.secure   = config.tlsEnabled;
  c.maxAge   = MAX_AGE;
  c.path     = "/";
}

// ─── Plugin factory ───────────────────────────────────────────────────────────

/**
 * Passkey (WebAuthn) plugin.
 *
 * Routes — all under /api/auth/passkey:
 *   POST /register-options    → generate registration challenge (session required)
 *   POST /register-verify     → verify + store new credential  (session required)
 *   POST /login-options       → generate authentication challenge (public)
 *   POST /login-verify        → verify assertion → issue JWT cookie (public)
 *   GET  /credentials         → list user's passkeys (session required)
 *   DELETE /credentials/:id   → remove a passkey (session required)
 */
export function passkeyPlugin(jwtSecret: string) {
  const guard = authGuard(jwtSecret);

  return new Elysia({ prefix: "/api/auth/passkey" })
    .use(jwt({ name: "jwt", secret: jwtSecret, exp: "7d" }))

    // ── Login options (public) ────────────────────────────────────────────────
    .post("/login-options", async ({ request, set }) => {
      const origin = request.headers.get("origin") ?? "";
      if (!originAllowed(origin)) {
        set.status = 403;
        return { error: `Origin "${origin}" is not in passkey_allowed_origins` };
      }

      pruneExpired();
      const rpId = rpIdFromOrigin(origin);

      const options = await generateAuthenticationOptions({
        rpID:             rpId,
        userVerification: "preferred",
        // No allowCredentials — let the browser show all resident keys for this rpId.
      });

      const nonce = crypto.randomUUID();
      pending.set(nonce, {
        challenge: options.challenge,
        rpId,
        expiresAt: Date.now() + 5 * 60 * 1000,
      });

      return { nonce, options };
    })

    // ── Login verify (public) ─────────────────────────────────────────────────
    .post(
      "/login-verify",
      async ({ body, jwt: jwtCtx, cookie: { anpan_session }, request, set }) => {
        const origin = request.headers.get("origin") ?? "";
        if (!originAllowed(origin)) {
          set.status = 403;
          return { error: `Origin "${origin}" is not in passkey_allowed_origins` };
        }

        const entry = pending.get(body.nonce);
        if (!entry || entry.expiresAt < Date.now()) {
          set.status = 400;
          return { error: "Challenge expired or not found — start over" };
        }
        pending.delete(body.nonce);

        const authResponse = body.response as AuthenticationResponseJSON;
        const passkey = await PasskeyStore.findByCredentialId(authResponse.id);
        if (!passkey) {
          set.status = 401;
          return { error: "Unknown credential" };
        }

        let verification;
        try {
          verification = await verifyAuthenticationResponse({
            response:          authResponse,
            expectedChallenge: entry.challenge,
            expectedOrigin:    origin,
            expectedRPID:      passkey.rpId,
            credential: {
              id:        passkey.credentialId,
              publicKey: Buffer.from(passkey.publicKey, "base64url"),
              counter:   passkey.counter,
            },
            requireUserVerification: false,
          });
        } catch (err) {
          set.status = 401;
          return { error: err instanceof Error ? err.message : "Verification failed" };
        }

        if (!verification.verified) {
          set.status = 401;
          return { error: "Authentication not verified" };
        }

        await PasskeyStore.updateCounter(passkey.id, verification.authenticationInfo.newCounter);

        const dbUser = await UserStore.findById(passkey.userId);
        if (!dbUser) { set.status = 500; return { error: "User not found" }; }

        const token = await jwtCtx.sign({ sub: String(dbUser.id), username: dbUser.username, tokenVersion: dbUser.tokenVersion ?? 0 });
        setSession(anpan_session as Parameters<typeof setSession>[0], token);

        return { ok: true, username: dbUser.username };
      },
      {
        cookie: cookieSchema,
        body:   t.Object({ nonce: t.String(), response: t.Any() }),
      },
    )

    // ── Protected routes (session required) ──────────────────────────────────
    .use(guard)

    // ── Register options ─────────────────────────────────────────────────────
    .post("/register-options", async ({ user, request, set }) => {
      const origin = request.headers.get("origin") ?? "";
      if (!originAllowed(origin)) {
        set.status = 403;
        return { error: `Origin "${origin}" is not in passkey_allowed_origins` };
      }

      pruneExpired();
      const rpId = rpIdFromOrigin(origin);
      const dbUser = await UserStore.findByUsername(user.username);
      if (!dbUser) { set.status = 404; return { error: "User not found" }; }

      const existingCreds = await PasskeyStore.findByUserId(dbUser.id);

      const options = await generateRegistrationOptions({
        rpName:    RP_NAME,
        rpID:      rpId,
        userName:  dbUser.username,
        attestationType: "none",
        excludeCredentials: existingCreds.map(pk => ({ id: pk.credentialId })),
        authenticatorSelection: {
          residentKey:      "preferred",
          userVerification: "preferred",
        },
      });

      const nonce = crypto.randomUUID();
      pending.set(nonce, {
        challenge: options.challenge,
        userId:    dbUser.id,
        rpId,
        expiresAt: Date.now() + 5 * 60 * 1000,
      });

      return { nonce, options };
    })

    // ── Register verify ──────────────────────────────────────────────────────
    .post(
      "/register-verify",
      async ({ body, request, set }) => {
        const origin = request.headers.get("origin") ?? "";
        if (!originAllowed(origin)) {
          set.status = 403;
          return { error: `Origin "${origin}" is not in passkey_allowed_origins` };
        }

        const entry = pending.get(body.nonce);
        if (!entry || entry.expiresAt < Date.now()) {
          set.status = 400;
          return { error: "Challenge expired or not found — start over" };
        }
        pending.delete(body.nonce);

        let verification;
        try {
          verification = await verifyRegistrationResponse({
            response:          body.response as RegistrationResponseJSON,
            expectedChallenge: entry.challenge,
            expectedOrigin:    origin,
            expectedRPID:      entry.rpId,
            requireUserVerification: false,
          });
        } catch (err) {
          set.status = 400;
          return { error: err instanceof Error ? err.message : "Verification failed" };
        }

        if (!verification.verified || !verification.registrationInfo) {
          set.status = 400;
          return { error: "Registration not verified" };
        }

        if (!entry.userId) {
          set.status = 400;
          return { error: "Invalid registration state — userId missing" };
        }

        const { credential } = verification.registrationInfo;

        await PasskeyStore.create({
          userId:       entry.userId,
          credentialId: credential.id,
          publicKey:    Buffer.from(credential.publicKey).toString("base64url"),
          counter:      credential.counter,
          rpId:         entry.rpId,
          deviceName:   body.deviceName ?? undefined,
        });

        return { ok: true };
      },
      {
        body: t.Object({
          nonce:      t.String(),
          response:   t.Any(),
          deviceName: t.Optional(t.String()),
        }),
      },
    )

    // ── List credentials ─────────────────────────────────────────────────────
    .get("/credentials", async ({ user }) => {
      const dbUser = await UserStore.findByUsername(user.username);
      if (!dbUser) return [];
      const creds = await PasskeyStore.findByUserId(dbUser.id);
      return creds.map(pk => ({
        id:          pk.id,
        deviceName:  pk.deviceName,
        rpId:        pk.rpId,
        createdAt:   pk.createdAt,
        lastUsedAt:  pk.lastUsedAt,
      }));
    })

    // ── Delete credential ────────────────────────────────────────────────────
    .delete(
      "/credentials/:id",
      async ({ user, params, set }) => {
        const dbUser = await UserStore.findByUsername(user.username);
        if (!dbUser) { set.status = 404; return { error: "User not found" }; }
        const deleted = await PasskeyStore.delete(Number(params.id), dbUser.id);
        if (!deleted) { set.status = 404; return { error: "Credential not found" }; }
        return { ok: true };
      },
      { params: t.Object({ id: t.String() }) },
    );
}
