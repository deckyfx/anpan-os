/**
 * What each API-key scope may reach, decided by method and path alone.
 *
 * Kept apart from the guard, and pure, so the whole policy can be read in one table and
 * tested as a matrix without a database or a Docker daemon. The web UI's copy text about
 * scopes is written from {@link API_KEY_RULES}, so a change here should be a change there.
 */

/** The three scopes a key can be created with, narrowest first. */
export const API_KEY_SCOPES = ["read", "operate", "full"] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

/** Methods that only read. HEAD is GET without a body, so it is judged as one. */
const READ_METHODS = ["GET", "HEAD"] as const;
/** Every method a route here answers that is not a read. */
const WRITE_METHODS = ["POST", "PUT", "PATCH", "DELETE"] as const;

/**
 * One line of the policy.
 *
 * `prefix` matches on segment boundaries: `/api/docker` covers `/api/docker` and
 * `/api/docker/…`, never `/api/dockerx`. `methods: "*"` matches any method, including ones
 * no route answers today. `minScope: null` means no key at all, whatever its scope.
 */
export interface ApiKeyRule {
  readonly prefix: string;
  readonly methods: readonly string[] | "*";
  readonly minScope: ApiKeyScope | null;
  /** Why the line exists — shown to nobody, kept for whoever next edits the table. */
  readonly reason: string;
}

/**
 * The policy, evaluated top to bottom; the first line whose prefix and method both match
 * decides. Refusals and exceptions therefore come before the grants they carve out of, the
 * way a firewall's rules do. A new route under a prefix listed here inherits that line's
 * grant for the methods it names: a new GET under /api/docker is readable with a `read` key.
 * A request that matches no narrower line falls to the `/api` line at the bottom and needs
 * `full`, so a whole new prefix reaches only `full` keys until someone decides here what
 * narrower keys may do with it.
 */
export const API_KEY_RULES: readonly ApiKeyRule[] = [
  // ── Never, with any key ──────────────────────────────────────────────────────
  {
    prefix: "/api/api-keys", methods: "*", minScope: null,
    reason: "A key that could mint keys would outlive its own revocation. Key management " +
            "takes the browser session only, and its plugin checks that itself as well.",
  },
  {
    prefix: "/api/auth", methods: "*", minScope: null,
    reason: "Passwords, passkeys, sessions and the Docker Hub login belong to the person. " +
            "A key that could register a passkey or change the password could take the " +
            "account over; passkey registration in particular sits behind authGuard.",
  },

  // ── Exceptions carved out of the grants below ────────────────────────────────
  {
    prefix: "/api/files", methods: "*", minScope: "full",
    reason: "File reads are not harmless: the file manager reaches everything under " +
            "files.root, which can be / — so a read key could fetch /etc/shadow or the " +
            "database holding every key's hash.",
  },
  {
    prefix: "/api/docker/prune", methods: "*", minScope: "full",
    reason: "Prune can delete unused volumes, and a volume is often the only copy of an " +
            "app's data.",
  },
  {
    prefix: "/api/docker/stacks", methods: ["DELETE"], minScope: "full",
    reason: "Destroying a stack removes its named volumes always, and bind-mounted host " +
            "directories on request — the same data loss that makes prune full-only.",
  },

  // ── read: look, never touch ──────────────────────────────────────────────────
  ...[
    "/api/me", "/api/docker", "/api/compose", "/api/system", "/api/samba",
    "/api/casaos", "/api/ports", "/api/bookmarks", "/api/app-store", "/api/jobs",
    "/api/openapi.json",
  ].map((prefix): ApiKeyRule => ({
    prefix, methods: READ_METHODS, minScope: "read",
    reason: "Status, lists, logs and the OpenAPI document: enough to monitor the box. Compose " +
            "and env files are readable here, and those can hold app passwords.",
  })),

  // ── operate: run the apps, not the machine ───────────────────────────────────
  ...[
    "/api/docker/stacks", "/api/docker/containers", "/api/docker/update-check",
    "/api/compose", "/api/app-store", "/api/bookmarks", "/api/ports", "/api/jobs",
  ].map((prefix): ApiKeyRule => ({
    prefix, methods: WRITE_METHODS, minScope: "operate",
    reason: "Start, stop, restart, pull, install and edit stacks, and follow or cancel those " +
            "jobs; check for updates; keep " +
            "bookmarks and port notes. Writing a compose file can mount any host path into a " +
            "container, so treat an operate key as nearly as powerful as a full one.",
  })),

  // ── full: everything else authGuard covers ───────────────────────────────────
  {
    prefix: "/api", methods: "*", minScope: "full",
    reason: "Files, Samba, CasaOS import, self-update, restart and shutdown — and any route " +
            "added later, until a line above says otherwise.",
  },
];

const SCOPE_RANK: Record<ApiKeyScope, number> = { read: 0, operate: 1, full: 2 };

/**
 * The path as the policy compares it, or null when it cannot be judged safely.
 *
 * The query is dropped, `//` collapsed, a trailing slash removed and each segment
 * percent-decoded and lowercased, so spellings a router might treat alike are judged alike:
 * `/api/%66iles` and `/API/Files` are `/api/files`. A `.` or `..` segment, or one that decodes
 * to a slash, is refused rather than resolved — `/api/docker/../files` must not be judged as
 * anything under /api/docker, and a path that needs resolving was not sent by honest client
 * code anyway.
 */
export function normaliseKeyPath(rawPath: string): string | null {
  const path = rawPath.split(/[?#]/, 1)[0] ?? "";
  const segments: string[] = [];
  for (const raw of path.split("/")) {
    if (raw === "") continue;
    let segment: string;
    try { segment = decodeURIComponent(raw); } catch { return null; }
    if (segment === "." || segment === ".." || /[\\/]/.test(segment)) return null;
    segments.push(segment.toLowerCase());
  }
  return "/" + segments.join("/");
}

/** Whether `path` is `prefix` or lies below it — whole segments only. */
function underPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(prefix + "/");
}

/** The policy line that decides this request, or null when none does. */
export function ruleFor(method: string, rawPath: string): ApiKeyRule | null {
  const path = normaliseKeyPath(rawPath);
  if (path === null) return null;
  const m = method.toUpperCase();
  return API_KEY_RULES.find(rule =>
    underPrefix(path, rule.prefix) && (rule.methods === "*" || rule.methods.includes(m)),
  ) ?? null;
}

/**
 * Whether a key of `scope` may make this request. Deny by default: an unparseable path, a
 * path no rule covers, a "never" rule and an unknown scope string all answer false.
 */
export function keyMayAccess(scope: string, method: string, path: string): boolean {
  if (!(API_KEY_SCOPES as readonly string[]).includes(scope)) return false;
  const rule = ruleFor(method, path);
  if (!rule || rule.minScope === null) return false;
  return SCOPE_RANK[scope as ApiKeyScope] >= SCOPE_RANK[rule.minScope];
}
