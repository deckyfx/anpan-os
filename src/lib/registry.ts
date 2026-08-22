/**
 * Minimal OCI/Docker registry client — just enough to answer "what digest is this tag now?"
 *
 * Replaces `docker manifest inspect --verbose`, which took 18–49s per image (a 46-image
 * sweep never finished) and, worse, reported a *per-platform manifest* digest that can
 * never equal the *index* digest Docker records locally in RepoDigests. This asks the
 * registry the same question Docker asks when pulling, so the two are comparable.
 */

import { parseImageRef, type ImageRef } from "./image-ref";
import type { CredentialSet, RegistryCredentials } from "./docker-credentials";

/**
 * Media types accepted when resolving a tag.
 *
 * The index/list types come first because a multi-arch tag resolves to an index, and that
 * index's digest is what Docker stores locally. Omitting them makes the registry return a
 * single platform's manifest instead, which is exactly the bug being fixed.
 */
const ACCEPT = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

export interface DigestResult {
  digest: string | null;
  /** Set when the registry refused HEAD and a GET was needed — GETs cost rate budget. */
  usedGetFallback: boolean;
  /** Remaining pulls in the current window, when the registry reports it. */
  rateLimitRemaining: number | null;
  error: string | null;
}

/**
 * Whether credentials may be sent to the auth server a registry nominated.
 *
 * The realm in a 401 challenge is chosen by the registry being queried, so a hostile or
 * compromised one could point it at a host it controls and collect whatever we send.
 * Credentials therefore travel only to the registry's own host, or to the auth service a
 * well-known registry is expected to use. Anywhere else we still fetch a token, just
 * anonymously — the check degrades to "public images only" rather than leaking a password.
 */
const TRUSTED_AUTH_HOSTS: Record<string, string[]> = {
  "registry-1.docker.io": ["auth.docker.io"],
};

function maySendCredentials(registry: string, realm: string): boolean {
  let url: URL;
  try { url = new URL(realm); } catch { return false; }
  // A matching host is not sufficient: an http realm would put the password on the wire
  // in cleartext, and the realm is chosen by the very host being authenticated to.
  if (url.protocol !== "https:") return false;
  if (url.host === registry) return true;
  return (TRUSTED_AUTH_HOSTS[registry] ?? []).includes(url.host);
}

/** Tokens are per-repository and short-lived; one cache per sweep avoids re-authenticating. */
export type TokenCache = Map<string, string>;

export function createTokenCache(): TokenCache {
  return new Map();
}

/**
 * Obtain a bearer token by following the registry's auth challenge.
 *
 * The realm and service are read from the 401 rather than hardcoded, which is what lets
 * the same code serve Docker Hub, ghcr.io, lscr.io and a private registry unchanged.
 */
async function getToken(
  ref: ImageRef,
  challenge: string,
  cache: TokenCache,
  signal: AbortSignal,
  credentials: RegistryCredentials | null,
): Promise<string | null> {
  const key = `${ref.registry}/${ref.repository}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const realm   = /realm="([^"]+)"/.exec(challenge)?.[1];
  const service = /service="([^"]+)"/.exec(challenge)?.[1];
  if (!realm) return null;

  const url = new URL(realm);
  if (service) url.searchParams.set("service", service);
  url.searchParams.set("scope", `repository:${ref.repository}:pull`);

  const headers: Record<string, string> = {};
  if (credentials && maySendCredentials(ref.registry, realm)) {
    const basic = Buffer.from(`${credentials.username}:${credentials.password}`).toString("base64");
    headers.Authorization = `Basic ${basic}`;
  }

  try {
    const res = await fetch(url, { headers, signal });
    if (!res.ok) return null;
    const body = await res.json() as { token?: string; access_token?: string };
    const token = body.token ?? body.access_token ?? null;
    if (token) cache.set(key, token);
    return token;
  } catch {
    return null;
  }
}

function readRateLimit(res: Response): number | null {
  // Format is "100;w=3600" — the count before the window parameter.
  const raw = res.headers.get("ratelimit-remaining") ?? res.headers.get("x-ratelimit-remaining");
  if (!raw) return null;
  const n = Number.parseInt(raw.split(";")[0] ?? "", 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Resolve the current digest for an image reference.
 *
 * HEAD is used deliberately: Docker Hub charges a manifest GET against the pull limit but
 * does not charge a HEAD (measured — remaining stayed at 100 across repeated HEADs and
 * dropped by one on a GET), so a full sweep is free. GET is attempted only when a registry
 * rejects HEAD outright, and is reported so the cost is visible.
 */
export async function fetchRemoteDigest(
  image: string,
  opts: {
    tokenCache?: TokenCache;
    timeoutMs?: number;
    credentials?: CredentialSet;
    /** Caller's cancellation, combined with the per-request timeout. */
    signal?: AbortSignal;
  } = {},
): Promise<DigestResult> {
  const { tokenCache = createTokenCache(), timeoutMs = 20_000, credentials, signal } = opts;

  // Without the caller's signal, cancelling a sweep only takes effect between images: an
  // in-flight request runs to its own timeout, so a cancelled run can take another 20
  // seconds to settle and publish its terminal event.
  const deadline = () => signal
    ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);
  const base: DigestResult = { digest: null, usedGetFallback: false, rateLimitRemaining: null, error: null };

  const ref = parseImageRef(image);
  if (!ref) return { ...base, error: "Unparseable image reference" };
  if (ref.digest)  return { ...base, digest: ref.digest };

  // Encode per segment: the repository is interpolated into a path, so a name containing
  // "..", a space or a percent would otherwise produce a malformed or traversing URL.
  // The slashes between segments are structural and must survive encoding.
  const repoPath = ref.repository.split("/").map(encodeURIComponent).join("/");
  const url = `https://${ref.registry}/v2/${repoPath}/manifests/${encodeURIComponent(ref.tag)}`;

  const request = async (method: "HEAD" | "GET", token: string | null): Promise<Response> => {
    const headers: Record<string, string> = { Accept: ACCEPT };
    if (token) headers.Authorization = `Bearer ${token}`;
    return fetch(url, { method, headers, signal: deadline() });
  };

  try {
    let token: string | null = null;
    let res = await request("HEAD", null);

    // Anonymous access to a public repo still needs a token on most registries; the 401
    // carries the instructions for getting one.
    if (res.status === 401) {
      const challenge = res.headers.get("www-authenticate") ?? "";
      token = await getToken(ref, challenge, tokenCache, deadline(), credentials?.for(ref.registry) ?? null);
      if (!token) return { ...base, error: "Authentication failed" };
      res = await request("HEAD", token);
    }

    let usedGetFallback = false;
    // 405/501 mean the registry does not implement HEAD; anything else is a real answer.
    if (res.status === 405 || res.status === 501) {
      usedGetFallback = true;
      res = await request("GET", token);
    }

    const rateLimitRemaining = readRateLimit(res);

    if (res.status === 404) return { ...base, usedGetFallback, rateLimitRemaining, error: "Image not found in registry" };
    // Registries answer 401 for a repository that is private *or* absent, deliberately, so
    // that anonymous callers cannot probe which private repositories exist. Reporting the
    // bare status would send someone hunting for a credentials problem that may not exist.
    if (res.status === 401 || res.status === 403) {
      return { ...base, usedGetFallback, rateLimitRemaining, error: "Not found, or needs credentials" };
    }
    if (res.status === 429) return { ...base, usedGetFallback, rateLimitRemaining, error: "Rate limited by registry" };
    if (!res.ok)            return { ...base, usedGetFallback, rateLimitRemaining, error: `Registry returned ${res.status}` };

    const digest = res.headers.get("docker-content-digest");
    if (!digest) return { ...base, usedGetFallback, rateLimitRemaining, error: "Registry did not return a digest" };

    return { digest, usedGetFallback, rateLimitRemaining, error: null };
  } catch (err) {
    if (signal?.aborted) return { ...base, error: "Cancelled" };
    const timedOut = err instanceof Error && err.name === "TimeoutError";
    return { ...base, error: timedOut ? `Timed out after ${timeoutMs}ms` : "Registry request failed" };
  }
}
