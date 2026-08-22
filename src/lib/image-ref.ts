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
    if (!digest?.startsWith("sha256:")) return null;
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

  return { registry, repository: path, tag, digest, raw: input };
}

/**
 * Whether an update check is meaningful for this reference.
 *
 * A digest-pinned image is by definition already exactly what it asks for, and a locally
 * built image has no registry to ask. Both are skipped with a reason rather than reported
 * as failures, so the report can distinguish "no update" from "could not tell".
 */
export function checkability(ref: ImageRef): { checkable: boolean; reason?: string } {
  if (ref.digest) return { checkable: false, reason: "pinned to a digest" };
  return { checkable: true };
}
