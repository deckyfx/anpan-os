/**
 * Docker image reference parsing.
 *
 * Split out as pure functions because the update checker's correctness rests on getting
 * this right, and the previous implementation's central bug — comparing a per-platform
 * manifest digest against an index digest — was invisible without something to assert on.
 */

/** A parsed image reference, resolved to the values the registry API needs. */
export interface ImageRef {
  /** Registry host to talk to, e.g. "registry-1.docker.io" or "ghcr.io". */
  registry: string;
  /** Full repository path, e.g. "library/nginx" or "thomiceli/opengist". */
  repository: string;
  /** Tag, e.g. "latest". Empty when the reference is digest-pinned. */
  tag: string;
  /** Digest when the reference is pinned to one, e.g. "sha256:…". */
  digest: string | null;
  /** The reference as written, for display. */
  raw: string;
}

const DOCKER_HUB_REGISTRY = "registry-1.docker.io";

/**
 * Docker's repository name grammar: lowercase alphanumerics, with separators between
 * them. Validating here means a malformed name is rejected once, rather than every
 * consumer having to guard against what it might do to a URL or a filesystem path.
 */
const REPOSITORY_RE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/;

/**
 * A registry host: dot-separated labels with an optional port, or localhost.
 *
 * Needed because {@link isRegistryHost} only asks whether a segment *looks* like a host,
 * and "." satisfies that — so "../etc/passwd" would otherwise parse as the registry ".."
 * with a perfectly valid-looking repository after it.
 */
const REGISTRY_RE = /^(?:localhost|(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)(?::\d{1,5})?$/;

/** Tags allow a wider set than repositories, but not path or query characters. */
const TAG_RE = /^[\w][\w.-]{0,127}$/;

/**
 * True when `part` is a registry host rather than the first segment of a repository path.
 *
 * Docker's own rule: the first segment is a host only if it contains a dot or a colon, or
 * is exactly "localhost". Without this, "myuser/app" would be read as host "myuser".
 */
function isRegistryHost(part: string): boolean {
  return part.includes(".") || part.includes(":") || part === "localhost";
}

/**
 * Parse an image reference into the pieces needed to query a registry.
 *
 * Handles the shorthand Docker accepts: a bare name means Docker Hub's `library/`
 * namespace, a missing tag means `latest`, and a `host:port/` prefix is a registry rather
 * than a namespace.
 */
export function parseImageRef(raw: string): ImageRef | null {
  const input = raw.trim();
  if (!input) return null;

  // Digest-pinned: everything after @ is the digest. A tag may also be present and is
  // then irrelevant — the digest is what was actually resolved.
  let remainder = input;
  let digest: string | null = null;
  const atIdx = remainder.lastIndexOf("@");
  if (atIdx !== -1) {
    digest = remainder.slice(atIdx + 1) || null;
    remainder = remainder.slice(0, atIdx);
    // A digest is 64 lowercase hex characters; anything else is not one, and letting a
    // short or malformed value through would put it into a registry URL unchecked.
    if (!/^sha256:[0-9a-f]{64}$/.test(digest ?? "")) return null;
  }

  const slash = remainder.indexOf("/");
  let registry = DOCKER_HUB_REGISTRY;
  let path = remainder;

  if (slash !== -1) {
    const head = remainder.slice(0, slash);
    if (isRegistryHost(head)) {
      registry = head;
      path = remainder.slice(slash + 1);
    }
  }

  // The tag separator is the last colon, but only when it belongs to the final path
  // segment — a "host:5000/repo" colon lives in the registry, which is already split off.
  let tag = "";
  const lastColon = path.lastIndexOf(":");
  if (lastColon !== -1 && !path.slice(lastColon + 1).includes("/")) {
    tag = path.slice(lastColon + 1);
    path = path.slice(0, lastColon);
  }

  if (!path) return null;

  // Docker Hub official images live under library/, which the shorthand omits.
  if (registry === DOCKER_HUB_REGISTRY && !path.includes("/")) {
    path = `library/${path}`;
  }

  if (!tag && !digest) tag = "latest";

  if (!REGISTRY_RE.test(registry))   return null;
  if (!REPOSITORY_RE.test(path))     return null;
  if (tag && !TAG_RE.test(tag))  return null;

  return { registry, repository: path, tag, digest, raw: input };
}

/**
 * Whether an update check is meaningful for this reference alone.
 *
 * A digest-pinned image is by definition already exactly what it asks for, so it is
 * skipped with a reason rather than reported as a failure — that lets the report separate
 * "no update" from "could not tell". Locally built images are also unanswerable, but that
 * cannot be seen from the reference: it is detected in the checker, from the absence of a
 * RepoDigests entry.
 */
export function checkability(ref: ImageRef): { checkable: boolean; reason?: string } {
  if (ref.digest) return { checkable: false, reason: "pinned to a digest" };
  return { checkable: true };
}
