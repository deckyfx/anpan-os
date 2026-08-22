/**
 * Registry credentials from Docker's own config file.
 *
 * Reusing `~/.docker/config.json` means a registry the user has already `docker login`-ed
 * to is checkable without asking them to configure anything twice. Only the plain `auth`
 * entries are read: `credsStore` and `credHelpers` delegate to external helper binaries,
 * which is a larger surface than this is worth, so those are reported as unsupported
 * rather than silently ignored.
 */

import { homedir } from "node:os";
import { join } from "node:path";

/** Docker Hub is spelled several ways in config.json; all mean the same registry. */
const DOCKER_HUB_KEYS = [
  "https://index.docker.io/v1/",
  "index.docker.io",
  "registry-1.docker.io",
  "docker.io",
];

export interface RegistryCredentials {
  username: string;
  password: string;
}

interface DockerConfig {
  auths?: Record<string, { auth?: string; username?: string; password?: string }>;
  credsStore?: string;
  credHelpers?: Record<string, string>;
}

export interface CredentialSet {
  /** Credentials for a registry host, or null when none are configured. */
  for(registry: string): RegistryCredentials | null;
  /** Registries that need an external credential helper we do not invoke. */
  readonly helperOnly: string[];
}

const EMPTY: CredentialSet = { for: () => null, helperOnly: [] };

function decodeAuth(entry: { auth?: string; username?: string; password?: string }): RegistryCredentials | null {
  if (entry.username && entry.password) {
    return { username: entry.username, password: entry.password };
  }
  if (!entry.auth) return null;
  try {
    const decoded = Buffer.from(entry.auth, "base64").toString("utf8");
    const sep = decoded.indexOf(":");
    if (sep === -1) return null;
    return { username: decoded.slice(0, sep), password: decoded.slice(sep + 1) };
  } catch {
    return null;
  }
}

/** Normalise a config key to a bare host so lookups match parsed image references. */
function normaliseKey(key: string): string {
  if (DOCKER_HUB_KEYS.includes(key)) return "registry-1.docker.io";

  // Keys are sometimes written as URLs; the host is the part that identifies a registry.
  let host = key.replace(/\/+$/, "");
  try {
    if (key.includes("://")) host = new URL(key).host;
  } catch { /* keep the trimmed raw key */ }

  // Canonicalise again after extraction: "https://docker.io/" reduces to "docker.io",
  // which is a Hub alias and must map on to registry-1.docker.io like the rest.
  return DOCKER_HUB_KEYS.includes(host) ? "registry-1.docker.io" : host;
}

/**
 * Load credentials from the Docker config of the user this process runs as.
 *
 * anpan-os runs as root under systemd, so this is normally /root/.docker/config.json —
 * the same file `docker login` writes when run with sudo.
 */
export async function loadDockerCredentials(configPath?: string): Promise<CredentialSet> {
  const path = configPath ?? join(homedir(), ".docker", "config.json");

  let parsed: DockerConfig;
  try {
    const file = Bun.file(path);
    if (!(await file.exists())) return EMPTY;
    parsed = await file.json() as DockerConfig;
  } catch {
    return EMPTY;
  }

  const table = new Map<string, RegistryCredentials>();
  const helperOnly: string[] = [];

  for (const [key, entry] of Object.entries(parsed.auths ?? {})) {
    const host = normaliseKey(key);
    const creds = decodeAuth(entry ?? {});
    if (creds) table.set(host, creds);
    else if (parsed.credsStore || parsed.credHelpers?.[key]) helperOnly.push(host);
  }

  for (const key of Object.keys(parsed.credHelpers ?? {})) {
    const host = normaliseKey(key);
    if (!table.has(host) && !helperOnly.includes(host)) helperOnly.push(host);
  }

  return {
    for: (registry: string) => table.get(normaliseKey(registry)) ?? null,
    helperOnly,
  };
}
