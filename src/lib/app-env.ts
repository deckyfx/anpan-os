/**
 * Values the app platform gives to installed apps, and the CasaOS conventions behind them.
 *
 * CasaOS app files leave a few values for the platform to fill in: `$AppID` (the app's
 * name), `$PUID`/`$PGID` (the user and group the app should write files as) and `$TZ`.
 * Docker Compose does not know them, so before this module they reached the containers
 * empty: volumes landed at `/DATA/AppData//config`, and images that drop privileges ran as
 * root.
 *
 * Compose already interpolates variables from the stack folder's `.env`, so the values are
 * written there rather than into the compose file. The file stays as its author wrote it,
 * and the user can see and change every value in the stack's env editor.
 */
import { parseDocument, isMap, isScalar, isSeq, type Document } from "yaml";
import { config } from "../config";

/** Variables CasaOS apps expect the platform to provide. */
export const PLATFORM_VARIABLES = ["AppID", "PUID", "PGID", "TZ"] as const;
export type PlatformVariable = (typeof PLATFORM_VARIABLES)[number];

/** Where CasaOS keeps app data; its store files hard-code this path. */
export const CASAOS_DATA_ROOT = "/DATA/AppData";

/** The values for `stack`, from `[apps]` in config.toml. */
export function platformValues(stack: string): Record<PlatformVariable, string> {
  const { puid, pgid } = config.appIds;
  return { AppID: stack, PUID: String(puid), PGID: String(pgid), TZ: config.appTimeZone };
}

/**
 * Names of the variables a compose file interpolates: `$NAME` and `${NAME…}`.
 *
 * `$$` is Compose's escape for a literal dollar and is skipped, so `$$HOME` in a command
 * meant for the container's shell is not mistaken for a variable.
 */
export function referencedVariables(compose: string): Set<string> {
  const names = new Set<string>();
  const text = compose.replaceAll("$$", "");
  for (const m of text.matchAll(/\$(?:\{([A-Za-z_][A-Za-z0-9_]*)|([A-Za-z_][A-Za-z0-9_]*))/g)) {
    names.add((m[1] ?? m[2])!);
  }
  return names;
}

/** Keys an `.env` file sets. Comments, blank lines and an `export ` prefix are handled. */
export function envKeys(env: string): Set<string> {
  const keys = new Set<string>();
  for (const raw of env.split("\n")) {
    const line = raw.trim().replace(/^export\s+/, "");
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq > 0) keys.add(line.slice(0, eq).trim());
  }
  return keys;
}

/**
 * Add the platform values `compose` uses and `env` does not already set.
 *
 * Only the referenced ones are added, so a stack that never mentions `$TZ` does not gain a
 * TZ line, and a value the user set by hand is never replaced.
 */
export function withPlatformDefaults(env: string, compose: string, stack: string): { env: string; added: PlatformVariable[] } {
  const used = referencedVariables(compose);
  const have = envKeys(env);
  const values = platformValues(stack);
  const added = PLATFORM_VARIABLES.filter(name => used.has(name) && !have.has(name));
  if (added.length === 0) return { env, added };

  const block = [
    "# Filled in by anpan-os for this app (set in [apps] in config.toml; edit to override)",
    ...added.map(name => `${name}=${values[name]}`),
  ].join("\n");
  const base = env.replace(/\s*$/, "");
  return { env: base ? `${base}\n\n${block}\n` : `${block}\n`, added };
}

/**
 * Point a CasaOS app's `/DATA/AppData/...` volumes at this machine's data root.
 *
 * Used for App Store installs only. A CasaOS stack already on this machine (migrate) has its
 * data at the path its file names, and moving the path would leave that data behind.
 * Edits the YAML document in place, so comments and every other key stay as they were.
 */
export function rewriteDataRoot(compose: string, to: string = config.appDataRoot): string {
  const from = CASAOS_DATA_ROOT;
  if (to === from) return compose;
  const doc = parseDocument(compose);
  if (doc.errors.length > 0) return compose;

  let changed = false;
  const swap = (path: string): string | null =>
    path === from || path.startsWith(`${from}/`) ? to + path.slice(from.length) : null;

  const services = doc.get("services");
  if (isMap(services)) {
    for (const item of services.items) {
      const volumes = isMap(item.value) ? item.value.get("volumes") : null;
      if (!isSeq(volumes)) continue;
      for (const entry of volumes.items) {
        if (isScalar(entry) && typeof entry.value === "string") {
          // Short syntax, "source:target[:mode]": only the source is a host path.
          const colon = entry.value.indexOf(":");
          const source = colon === -1 ? entry.value : entry.value.slice(0, colon);
          const next = swap(source);
          if (next !== null) {
            entry.value = next + (colon === -1 ? "" : entry.value.slice(colon));
            changed = true;
          }
        } else if (isMap(entry)) {
          const source = entry.get("source");
          const next = typeof source === "string" ? swap(source) : null;
          if (next !== null) {
            entry.set("source", next);
            changed = true;
          }
        }
      }
    }
  }
  return changed ? stringify(doc) : compose;
}

function stringify(doc: Document): string {
  // lineWidth 0: never fold long strings, which would change how a command reads.
  // flowCollectionPadding off: keep `["sh", "-c"]` as written, not `[ "sh", "-c" ]`.
  return doc.toString({ lineWidth: 0, flowCollectionPadding: false });
}
