import { parse } from "yaml";
import { readdir } from "node:fs/promises";

const APPS_DIR = "/var/lib/casaos/apps";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CasaOSApp {
  /** Directory name — matches the Docker Compose project name. */
  id:          string;
  title:       string;
  icon:        string;
  tagline:     string;
  description: string;
  tips:        string;
  scheme:      string;
  portMap:     string;
  index:       string;
  mainService: string;
  storeAppId:  string;
}

// ─── Reader ───────────────────────────────────────────────────────────────────

async function readFile(path: string): Promise<string | null> {
  // Direct read (works when server runs as root or file is world-readable).
  try {
    return await Bun.file(path).text();
  } catch {}

  // Fallback: sudo -n (works when NOPASSWD is configured for the server user).
  const result = await Bun.$`sudo -n cat ${path}`.quiet().nothrow();
  if (result.exitCode === 0) return result.stdout.toString();

  return null;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function strDate(v: unknown): string {
  if (typeof v === "string") return v;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return "";
}

function localised(v: unknown): string {
  if (typeof v === "string") return v;
  if (!v || typeof v !== "object" || Array.isArray(v)) return "";
  const m = v as Record<string, unknown>;
  // Use || (not ??) so empty-string values fall through to the next locale key.
  for (const k of ["custom", "en_us", "en_US"]) {
    if (typeof m[k] === "string" && m[k]) return m[k] as string;
  }
  return (Object.values(m).find(x => typeof x === "string" && x) as string) || "";
}

/**
 * Extract a human-readable tip string from a CasaOS `x-casaos.tips` block.
 *
 * The tips block can be:
 *  - a plain string
 *  - `{custom: "..."}` — user-written note (credentials, port info, etc.)
 *  - `{before_install: {en_us: "...", zh_cn: "..."}}` — locale map
 *  - a combination of both keys
 *
 * `custom` is always preferred; `before_install` is the fallback.
 */
function extractTips(v: unknown): string {
  if (typeof v === "string") return v;
  if (!v || typeof v !== "object" || Array.isArray(v)) return "";
  const m = v as Record<string, unknown>;
  if (typeof m["custom"] === "string" && m["custom"]) return m["custom"];
  return localised(m["before_install"]);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** Parse `x-casaos` metadata from a raw compose YAML string. Returns null if the block is absent or malformed. */
export function parseCasaOSMeta(raw: string): CasaOSApp | null {
  try {
    const doc  = parse(raw) as Record<string, unknown>;
    const meta = doc["x-casaos"] as Record<string, unknown> | undefined;
    if (!meta) return null;
    return {
      id:          "",
      title:       localised(meta["title"]),
      icon:        str(meta["icon"]),
      tagline:     localised(meta["tagline"]),
      description: localised(meta["description"]),
      tips:        extractTips(meta["tips"]),
      scheme:      str(meta["scheme"]) || "http",
      portMap:     str(meta["port_map"]),
      index:       str(meta["index"]) || "/",
      mainService: str(meta["main"]),
      storeAppId:  str(meta["store_app_id"]),
    };
  } catch {
    return null;
  }
}

// ─── Remote App Store ─────────────────────────────────────────────────────────

const FETCH_TIMEOUT_MS = 10_000;

/** Wrap fetch with an AbortController-based timeout. */
function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

/** Thrown when an HTTP response is not ok; carries the numeric status code. */
export class FetchResponseError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "FetchResponseError";
  }
}

/** An app fetched from a remote CasaOS-compatible GitHub repository. */
export interface RemoteCasaOSApp {
  /** Composite key: "{repoId}::{appName}" */
  id:              string;
  repoId:          number;
  appName:         string;
  title:           string;
  icon:            string;
  tagline:         string;
  description:     string;
  category:        string;
  developer:       string;
  author:          string;
  thumbnail:       string;
  screenshots:     string[];
  beforeInstallTip: string;
  portMap:         string;
  mainService:     string;
  architectures:   string[];
  /** raw.githubusercontent.com URL for the compose file */
  composeUrl:      string;
  /** App version string from x-casaos.version */
  version:         string;
  /** ISO date string from x-casaos.updateAt */
  updatedAt:       string;
  /** Localised release notes from x-casaos.releaseNotes */
  releaseNotes:    string;
  /** App home page URL from x-casaos.website */
  website:         string;
  /** Source code URL from x-casaos.repo */
  repo:            string;
  /** Support / issue tracker URL from x-casaos.support */
  support:         string;
  /** Documentation URL from x-casaos.docs */
  docs:            string;
}

/** Parse a github.com repo URL into owner and repo name. */
export function parseGithubUrl(url: string): { owner: string; repo: string } {
  const u = new URL(url.trim());
  const parts = u.pathname.replace(/^\//, "").replace(/\.git$/, "").split("/");
  const owner = parts[0];
  const repo  = parts[1];
  if (!owner || !repo) throw new Error(`Cannot parse GitHub URL: ${url}`);
  return { owner, repo };
}

/**
 * Resolve the default branch for a GitHub repo.
 * Returns undefined when the repo is not found (404).
 * Throws FetchResponseError for other non-ok responses; AbortError propagates on timeout.
 */
async function fetchDefaultBranch(owner: string, repo: string): Promise<string | undefined> {
  const resp = await fetchWithTimeout(
    `https://api.github.com/repos/${owner}/${repo}`,
    { headers: { Accept: "application/vnd.github+json", "User-Agent": "anpan-os" } },
  );
  if (resp.status === 404) return undefined;
  if (!resp.ok) throw new FetchResponseError(resp.status, `GitHub API ${resp.status}: ${resp.statusText}`);
  const data = (await resp.json()) as { default_branch?: string };
  return data.default_branch ?? "main";
}

/** Fetch the list of app folder names from a GitHub repo's Apps/ directory. */
async function fetchAppList(owner: string, repo: string): Promise<string[]> {
  const resp = await fetchWithTimeout(
    `https://api.github.com/repos/${owner}/${repo}/contents/Apps`,
    { headers: { Accept: "application/vnd.github+json", "User-Agent": "anpan-os" } },
  );
  if (!resp.ok) throw new Error(`GitHub API ${resp.status}: ${resp.statusText}`);
  const entries = (await resp.json()) as { name: string; type: string }[];
  return entries.filter(e => e.type === "dir").map(e => e.name);
}

/**
 * Fetch and parse one app's compose file.
 * Tries resolvedBranch first (when provided), then falls back to "main" and "master".
 * Returns null only on true 404 (all branches) or missing x-casaos block.
 * Throws FetchResponseError on non-404 HTTP errors; AbortError propagates on timeout.
 */
async function fetchAndParseApp(
  owner: string, repo: string, appName: string,
  repoId: number, resolvedBranch: string | undefined,
): Promise<RemoteCasaOSApp | null> {
  // Build branch queue: resolved branch first, then common fallbacks (deduped).
  const branchQueue: string[] = resolvedBranch
    ? [resolvedBranch, ...["main", "master"].filter(b => b !== resolvedBranch)]
    : ["main", "master"];

  let raw: string | undefined;
  let usedComposeUrl = "";

  for (const branch of branchQueue) {
    const url = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/Apps/${encodeURIComponent(appName)}/docker-compose.yml`;
    const resp = await fetchWithTimeout(url, { headers: { "User-Agent": "anpan-os" } });
    if (resp.status === 404) continue;
    if (!resp.ok) throw new FetchResponseError(resp.status, `Fetch failed ${resp.status}: ${url}`);
    raw = await resp.text();
    usedComposeUrl = url;
    break;
  }

  if (raw === undefined) return null; // not found on any branch

  try {
    const doc    = parse(raw) as Record<string, unknown>;
    const meta   = doc["x-casaos"] as Record<string, unknown> | undefined;
    if (!meta) return null;

    const services    = (doc["services"] ?? {}) as Record<string, unknown>;
    const serviceKeys = Object.keys(services);
    const mainSvc     = str(meta["main"]) || (serviceKeys[0] ?? "");

    // architectures may be a list or absent
    const archRaw = meta["architectures"];
    const archs: string[] = Array.isArray(archRaw)
      ? archRaw.map(a => String(a))
      : [];

    // screenshots may be a list of strings
    const ssRaw = meta["screenshot_link"];
    const screenshots: string[] = Array.isArray(ssRaw)
      ? ssRaw.map(s => String(s))
      : [];

    return {
      id:              `${repoId}::${appName}`,
      repoId,
      appName,
      title:           localised(meta["title"]) || appName,
      icon:            str(meta["icon"]),
      tagline:         localised(meta["tagline"]),
      description:     localised(meta["description"]),
      category:        localised(meta["category"]),
      developer:       str(meta["developer"]),
      author:          str(meta["author"]),
      thumbnail:       str(meta["thumbnail"]),
      screenshots,
      beforeInstallTip: extractTips(meta["tips"]) || localised(meta["before_install_tip"]),
      portMap:         str(meta["port_map"]),
      mainService:     mainSvc,
      architectures:   archs,
      composeUrl:      usedComposeUrl,
      version:         str(meta["version"]),
      updatedAt:       strDate(meta["updateAt"]),
      releaseNotes:    localised(meta["releaseNotes"]),
      website:         str(meta["website"]),
      repo:            str(meta["repo"]),
      support:         str(meta["support"]),
      docs:            str(meta["docs"]),
    };
  } catch {
    return null;
  }
}

/**
 * Fetch all apps from a CasaOS-compatible GitHub repository.
 * Apps are fetched in parallel chunks of 10 to avoid overwhelming GitHub's API.
 */
export async function fetchRemoteCasaOSApps(
  repoId: number, repoUrl: string,
): Promise<RemoteCasaOSApp[]> {
  const { owner, repo } = parseGithubUrl(repoUrl);

  // Resolve the default branch; treat branch-resolution failures as unknown so
  // fetchAndParseApp can still try all common branches as fallback.
  let resolvedBranch: string | undefined;
  try {
    resolvedBranch = await fetchDefaultBranch(owner, repo);
  } catch {
    resolvedBranch = undefined;
  }

  let appNames: string[];
  try {
    appNames = await fetchAppList(owner, repo);
  } catch {
    throw new Error(`Failed to list apps from ${repoUrl}`);
  }

  const results: RemoteCasaOSApp[] = [];
  const CHUNK = 10;

  for (let i = 0; i < appNames.length; i += CHUNK) {
    const chunk = appNames.slice(i, i + CHUNK);
    const apps  = await Promise.all(
      chunk.map(name => fetchAndParseApp(owner, repo, name, repoId, resolvedBranch)),
    );
    for (const app of apps) {
      if (app) results.push(app);
    }
  }

  return results;
}

/** Fetch raw compose YAML for a specific app using its stored composeUrl. */
export async function fetchRemoteComposeContent(composeUrl: string): Promise<string> {
  const resp = await fetchWithTimeout(composeUrl, { headers: { "User-Agent": "anpan-os" } });
  if (!resp.ok) throw new FetchResponseError(resp.status, `Failed to fetch compose: ${resp.status} ${resp.statusText}`);
  return resp.text();
}

// ─── Local CasaOS Apps ────────────────────────────────────────────────────────

/** Read and parse all CasaOS app compose files. Returns only readable apps. */
export async function readCasaOSApps(): Promise<CasaOSApp[]> {
  let entries: string[];
  try {
    entries = await readdir(APPS_DIR);
  } catch {
    return [];
  }

  const apps: CasaOSApp[] = [];

  for (const name of entries) {
    const filePath = `${APPS_DIR}/${name}/docker-compose.yml`;
    const raw = await readFile(filePath);
    if (!raw) continue;

    try {
      const doc    = parse(raw) as Record<string, unknown>;
      const meta   = doc["x-casaos"] as Record<string, unknown> | undefined;
      if (!meta) continue;

      apps.push({
        id:          name,
        title:       localised(meta["title"]) || name,
        icon:        str(meta["icon"]),
        tagline:     localised(meta["tagline"]),
        description: localised(meta["description"]),
        tips:        extractTips(meta["tips"]),
        scheme:      str(meta["scheme"]) || "http",
        portMap:     str(meta["port_map"]),
        index:       str(meta["index"]) || "/",
        mainService: str(meta["main"]),
        storeAppId:  str(meta["store_app_id"]) || name,
      });
    } catch {
      // Skip malformed compose files.
    }
  }

  return apps;
}
