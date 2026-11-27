/**
 * Minimal OCI/Docker registry client — just enough to answer "what digest is this tag now?"
 *
 * Replaces `docker manifest inspect --verbose`, which took 18–49s per image (a 46-image
 * sweep never finished) and, worse, reported a *per-platform manifest* digest that can
 * never equal the *index* digest Docker records locally in RepoDigests. This asks the
 * registry the same question Docker asks when pulling, so the two are comparable.
 */

import { parseImageRef, DOCKER_HUB_REGISTRY, type ImageRef } from "./image-ref";
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

/**
 * The Authorization header to retry with after a 401, or null when there is none to send.
 *
 * Most registries answer with a Bearer challenge, whose realm issues a token. A registry run
 * with `htpasswd` auth (distribution's own option) answers `Basic realm="…"` instead, where
 * the realm is a label, not a URL; handing that to the token flow failed every lookup even
 * with a matching `docker login`. Basic credentials go only to the registry itself, which is
 * the host this request was sent to over https, so the realm rules in maySendCredentials
 * do not apply.
 */
async function authorizationFor(
  ref: ImageRef,
  challenge: string,
  cache: TokenCache,
  signal: AbortSignal,
  credentials: RegistryCredentials | null,
): Promise<string | null> {
  if (/^\s*basic\b/i.test(challenge)) {
    if (!credentials) return null;
    return `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString("base64")}`;
  }
  const token = await getToken(ref, challenge, cache, signal, credentials);
  return token ? `Bearer ${token}` : null;
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

  const request = async (method: "HEAD" | "GET", authorization: string | null): Promise<Response> => {
    const headers: Record<string, string> = { Accept: ACCEPT };
    if (authorization) headers.Authorization = authorization;
    return fetch(url, { method, headers, signal: deadline() });
  };

  try {
    let token: string | null = null;
    let res = await request("HEAD", null);

    // Anonymous access to a public repo still needs a token on most registries; the 401
    // carries the instructions for getting one.
    if (res.status === 401) {
      const challenge = res.headers.get("www-authenticate") ?? "";
      token = await authorizationFor(ref, challenge, tokenCache, deadline(), credentials?.for(ref.registry) ?? null);
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

// ─── Tag listing ──────────────────────────────────────────────────────────────

/** One tag as offered in the image tag picker. */
export interface TagEntry {
  name: string;
  /** When the tag was last pushed. Only Docker Hub's own API reports this. */
  updated: string | null;
}

export type TagListResult =
  | { ok: true; tags: TagEntry[] }
  | { ok: false; reason: "invalid" | "not-found" | "rate-limited" | "failed"; error: string };

/** How many tags the picker shows. Large repositories have thousands. */
const MAX_TAGS = 100;
/** Pages of `tags/list` followed before giving up on reading the rest. */
const MAX_PAGES = 10;

/**
 * Tags that are not images at all: cosign stores signatures, attestations and SBOMs as
 * `sha256-<digest>.sig` and similar, and ghcr lists them next to the real tags.
 */
const ARTIFACT_TAG_RE = /^sha256-[0-9a-f]{64}(?:\.[a-z]+)?$/;

/** Tags that follow a release line rather than naming one, shown first in this order. */
const MOVING_TAGS = ["latest", "stable", "main", "master", "edge", "nightly", "dev"];
/**
 * A version: optional "v", then dotted numbers, e.g. 18.25.1 or v2.0-rc1. The dot is
 * required because a bare number is ambiguous: atuin tags commits as 9933220, which would
 * otherwise outrank every real release.
 */
const VERSION_TAG_RE = /^v?\d+\.\d/;
/** A commit hash used as a tag, e.g. ffeff77, sha-1a2b3c4 or ffeff77-aarch64. */
const COMMIT_TAG_RE = /^(?:sha-)?(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}(?:-[\w.]+)?$/;

const numeric = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true });

/** Group a tag sorts into: moving tags, versions, other names, commit hashes. */
function tagGroup(tag: string): number {
  if (MOVING_TAGS.includes(tag)) return 0;
  if (COMMIT_TAG_RE.test(tag))   return 3;
  if (VERSION_TAG_RE.test(tag))  return 1;
  return 2;
}

/**
 * Compare two version tags, newest first. A release sorts before its pre-releases and
 * variants: 18.24.0, then 18.24.0-beta.2, then 18.24.0-alpine.
 */
function compareVersions(a: string, b: string): number {
  const split = (t: string) => {
    const s = t.replace(/^v/, "");
    const end = s.search(/[^0-9.]/);
    return end === -1 ? [s, ""] as const : [s.slice(0, end), s.slice(end)] as const;
  };
  const [baseA, restA] = split(a);
  const [baseB, restB] = split(b);
  return numeric(baseB, baseA)
    || Number(restA !== "") - Number(restB !== "")
    || numeric(restA, restB)
    || numeric(a, b);
}

/**
 * Order tags the way someone choosing one wants them.
 *
 * A registry's `tags/list` has no dates, and its order is the registry's own: ghcr returns
 * oldest first, so atuin's 2,900 tags put 18.25.1 last, behind every commit-hash tag. Moving
 * tags such as `latest` come first, then versions newest first (comparing digit runs as
 * numbers, so 18.21 is newer than 18.3), then other names (bare numbers such as date
 * builds among them, highest first), then commit hashes.
 */
export function sortTagsNewestFirst(tags: string[]): string[] {
  return [...tags].sort((a, b) => {
    const ga = tagGroup(a), gb = tagGroup(b);
    if (ga !== gb) return ga - gb;
    if (ga === 0) return MOVING_TAGS.indexOf(a) - MOVING_TAGS.indexOf(b);
    if (ga === 1) return compareVersions(a, b);
    if (ga === 2) return numeric(b, a);
    return numeric(a, b);
  });
}

/**
 * List the tags of an image's repository, for the tag picker.
 *
 * Docker Hub repositories are read through Hub's own API, which sorts by push date. Every
 * other registry (ghcr.io, lscr.io, quay.io, a private one) is read through the standard
 * registry `tags/list` endpoint. The picker used to send every image to Hub, so
 * `ghcr.io/owner/app` became the Hub repository `ghcr.io/owner` and always failed with 404.
 */
export async function listTags(
  image: string,
  opts: { credentials?: CredentialSet; timeoutMs?: number } = {},
): Promise<TagListResult> {
  const { credentials, timeoutMs = 8_000 } = opts;
  const ref = parseImageRef(image);
  if (!ref) return { ok: false, reason: "invalid", error: `"${image}" is not a valid image name` };

  const signal = AbortSignal.timeout(timeoutMs);
  try {
    if (ref.registry === DOCKER_HUB_REGISTRY) {
      const hub = await listHubTags(ref, signal);
      // Hub's API answers 404 for a private repository as well as a missing one. The
      // registry API can still read a private one with the login from `docker login`.
      if (hub.ok || hub.reason !== "not-found" || !credentials?.for(ref.registry)) return hub;
      const viaRegistry = await listRegistryTags(ref, signal, credentials);
      return viaRegistry.ok ? viaRegistry : hub;
    }
    return await listRegistryTags(ref, signal, credentials);
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "TimeoutError";
    return { ok: false, reason: "failed", error: timedOut ? `${ref.registry} did not answer in time` : `Could not reach ${ref.registry}` };
  }
}

/** Encode each segment of a repository path while keeping the slashes between them. */
function encodeRepository(repository: string): string {
  return repository.split("/").map(encodeURIComponent).join("/");
}

/** The name people write for a repository: Hub's official images without "library/". */
function displayName(ref: ImageRef): string {
  if (ref.registry !== DOCKER_HUB_REGISTRY) return `${ref.registry}/${ref.repository}`;
  return ref.repository.replace(/^library\//, "");
}

async function listHubTags(ref: ImageRef, signal: AbortSignal): Promise<TagListResult> {
  const url = `https://hub.docker.com/v2/repositories/${encodeRepository(ref.repository)}/tags?page_size=100&ordering=last_updated`;
  const res = await fetch(url, { headers: { Accept: "application/json" }, signal });

  if (res.status === 404) {
    return { ok: false, reason: "not-found", error: `Docker Hub has no public repository named ${displayName(ref)}` };
  }
  if (res.status === 429) return { ok: false, reason: "rate-limited", error: "Docker Hub is rate-limiting requests; try again shortly" };
  if (!res.ok) return { ok: false, reason: "failed", error: `Docker Hub returned ${res.status}` };

  const data = await res.json() as { results?: Array<{ name: string; last_updated?: string | null }> };
  return {
    ok: true,
    tags: (data.results ?? []).map(r => ({ name: r.name, updated: r.last_updated ?? null })),
  };
}

async function listRegistryTags(
  ref: ImageRef,
  signal: AbortSignal,
  credentials: CredentialSet | undefined,
): Promise<TagListResult> {
  const origin = `https://${ref.registry}`;
  let next: string | null = `${origin}/v2/${encodeRepository(ref.repository)}/tags/list?n=1000`;
  let token: string | null = null;
  const names: string[] = [];

  for (let page = 0; next && page < MAX_PAGES; page++) {
    const url: string = next;
    const get = (authorization: string | null) => fetch(url, {
      headers: { Accept: "application/json", ...(authorization ? { Authorization: authorization } : {}) },
      signal,
    });

    let res = await get(token);
    if (res.status === 401 && !token) {
      const challenge = res.headers.get("www-authenticate") ?? "";
      token = await authorizationFor(ref, challenge, createTokenCache(), signal, credentials?.for(ref.registry) ?? null);
      if (token) res = await get(token);
    }

    if (res.status === 404) {
      return { ok: false, reason: "not-found", error: `${ref.registry} has no repository named ${ref.repository}` };
    }
    // As with manifests, 401/403 covers a private repository and an absent one alike.
    if (res.status === 401 || res.status === 403) {
      return { ok: false, reason: "not-found", error: `${displayName(ref)} was not found, or needs a registry login` };
    }
    if (res.status === 429) return { ok: false, reason: "rate-limited", error: `${ref.registry} is rate-limiting requests; try again shortly` };
    if (!res.ok) return { ok: false, reason: "failed", error: `${ref.registry} returned ${res.status}` };

    const body = await res.json() as { tags?: string[] | null };
    names.push(...(body.tags ?? []));
    next = nextPage(res.headers.get("link"), url);
  }

  const tags = sortTagsNewestFirst(names.filter(n => !ARTIFACT_TAG_RE.test(n)))
    .slice(0, MAX_TAGS)
    .map(name => ({ name, updated: null }));
  return { ok: true, tags };
}

/**
 * The next page from a `Link: </v2/…?last=x>; rel="next"` header.
 *
 * The target may be relative to the page just read (`<?last=x>`), so it is resolved against
 * that URL. It is followed only on the same origin: the header comes from the registry, and
 * a token for it must not be sent wherever the header points.
 */
export function nextPage(link: string | null, current: string): string | null {
  const target = link && /<([^>]+)>\s*;\s*rel="?next"?/.exec(link)?.[1];
  if (!target) return null;
  try {
    const base = new URL(current);
    const url = new URL(target, base);
    return url.origin === base.origin ? url.href : null;
  } catch {
    return null;
  }
}
