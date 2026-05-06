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

function localised(v: unknown): string {
  if (!v || typeof v !== "object") return "";
  const m = v as Record<string, string>;
  return m["custom"] || m["en_us"] || "";
}

// ─── Public API ───────────────────────────────────────────────────────────────

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
        tips:        localised(meta["tips"]),
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
