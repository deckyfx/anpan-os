import { timingSafeEqual } from "node:crypto";
import { ApiKeyStore } from "../stores/api-key-store";
import type { ApiKey, User } from "../db/schema";
import type { ApiKeyScope } from "./api-key-scope";

/**
 * Issuing and checking API keys — the Bearer counterpart of lib/session-auth.
 *
 * A token is `anpan_<id>_<secret>`: the id finds the row without a scan, the secret proves
 * possession. The prefix makes a leaked key recognisable to secret scanners and to a person
 * reading a log, and tells this server a Bearer token is one of its own.
 */

/** `anpan_` + 12 hex id + `_` + 43 base64url chars (32 bytes, unpadded). */
const TOKEN_RE = /^anpan_([0-9a-f]{12})_([A-Za-z0-9_-]{43})$/;

/** A key as a handler may see it: enough to name it in a log, nothing that authenticates. */
export interface ApiKeyIdentity {
  id: string;
  name: string;
  scope: ApiKeyScope;
}

/**
 * Hex SHA-256 of a secret.
 *
 * A fast hash is right here, unlike for passwords: the secret is 256 random bits, so there
 * is no guessable space for a slow hash to protect, and bcrypt on every keyed request would
 * cost tens of milliseconds for nothing.
 */
export function hashSecret(secret: string): string {
  return new Bun.CryptoHasher("sha256").update(secret).digest("hex");
}

/** A fresh token and what to store for it. The token itself is never stored. */
export function generateApiKeyToken(): { id: string; token: string; secretHash: string } {
  const id = Buffer.from(crypto.getRandomValues(new Uint8Array(6))).toString("hex");
  const secret = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  return { id, token: `anpan_${id}_${secret}`, secretHash: hashSecret(secret) };
}

/** Split a token into id and secret, or null if it is not shaped like one of ours. */
export function parseApiKeyToken(token: string): { id: string; secret: string } | null {
  const m = TOKEN_RE.exec(token);
  return m ? { id: m[1]!, secret: m[2]! } : null;
}

/**
 * The credential of an `Authorization: Bearer …` header, "" for a Bearer header with none,
 * or null when the request presents no Bearer credential.
 *
 * Other schemes are not ours and are ignored. A reverse proxy doing HTTP Basic auth passes
 * the browser's `Authorization: Basic …` through on every request, and treating that as a
 * failed key would sign out every cookie user behind it.
 */
export function bearerCredential(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (header === null) return null;
  const m = /^\s*bearer(?:\s+(.*))?$/i.exec(header);
  return m ? (m[1] ?? "").trim() : null;
}

/** Whether two hex digests are equal, in time that does not depend on where they differ. */
function sameDigest(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * The key and user a token stands for, or null — malformed, unknown, wrong secret, expired,
 * or its user gone. One answer for all of them, so a caller probing ids learns nothing from
 * the reply about which ids exist.
 */
export async function verifyApiKey(token: string): Promise<{ key: ApiKey; user: User } | null> {
  const parsed = parseApiKeyToken(token);
  if (!parsed) return null;
  const found = await ApiKeyStore.findWithUser(parsed.id);
  if (!found || !sameDigest(hashSecret(parsed.secret), found.key.secretHash)) return null;
  if (found.key.expiresAt && found.key.expiresAt.getTime() <= Date.now()) return null;
  return found;
}

/** How often a key's last-used fields may be written. */
const TOUCH_INTERVAL_MS = 60_000;

/** When each key's last-used fields were last written, by id. Bounded by the key count. */
const lastTouched = new Map<string, number>();

/**
 * Record that a key was used, at most once a minute.
 *
 * Without the throttle every keyed request would be a database write, and an agent polling
 * /stats would keep SQLite busy for a timestamp nobody needs to the second. A failed write
 * is logged and forgotten: losing a last-used time must never fail the request it describes.
 */
export async function noteApiKeyUse(id: string, ip: string | null, now = Date.now()): Promise<void> {
  const last = lastTouched.get(id);
  if (last !== undefined && now - last < TOUCH_INTERVAL_MS) return;
  lastTouched.set(id, now);
  try {
    await ApiKeyStore.touch(id, new Date(now), ip);
  } catch (err) {
    console.warn(`[api-key] could not record use of ${id}:`, err instanceof Error ? err.message : err);
  }
}

/** Drop a deleted key's throttle entry, so the map stays the size of the live key set. */
export function forgetApiKeyUse(id: string): void {
  lastTouched.delete(id);
}
