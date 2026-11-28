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
import { parseDocument, isAlias, isMap, isScalar, isSeq, type Document } from "yaml";
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

/** Where the quote closing a value opened with `quote` is in `body`, or -1. `\"` does not close. */
function closingQuote(body: string, quote: string): number {
  for (let i = 0; i < body.length; i++) {
    if (quote === '"' && body[i] === "\\") { i++; continue; }
    if (body[i] === quote) return i;
  }
  return -1;
}

/**
 * The assignments in an `.env` file, in order, as Compose reads them: `KEY=value` or
 * `KEY: value`, with an optional `export ` prefix. Comments and blank lines are skipped.
 *
 * Values follow Compose's rules, so that what this reads is what Compose substitutes:
 * - A quoted value runs to its closing quote, across lines if need be. Lines inside it are
 *   part of the value, not assignments: `NOTES='a\nTZ=x\nb'` does not set TZ.
 * - In an unquoted value, ` #` starts a comment: `PUID=2001 # app user` is 2001. A quoted
 *   value keeps its `#`.
 * Escapes inside double quotes are not expanded; nothing here needs them.
 */
function envAssignments(env: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const lines = env.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim().replace(/^export\s+/, "");
    if (!line || line.startsWith("#")) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_.-]*)\s*(?:=|:(?=\s|$))\s*(.*)$/.exec(line);
    if (!m) continue;
    const rest = m[2] ?? "";
    const quote = rest[0];
    let value: string;
    if (quote === '"' || quote === "'") {
      let body = rest.slice(1);
      let end = closingQuote(body, quote);
      while (end < 0 && i + 1 < lines.length) {
        body += `\n${lines[++i]}`;
        end = closingQuote(body, quote);
      }
      value = end < 0 ? body : body.slice(0, end);
    } else {
      value = rest.split(" #")[0]!.trimEnd();
    }
    out.push([m[1]!, value]);
  }
  return out;
}

/** Keys an `.env` file sets. */
export function envKeys(env: string): Set<string> {
  return new Set(envAssignments(env).map(([key]) => key));
}

/** The value `.env` gives `key`; the last assignment wins, as in Compose. Null when unset. */
export function envValue(env: string, key: string): string | null {
  let value: string | null = null;
  for (const [k, v] of envAssignments(env)) if (k === key) value = v;
  return value;
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

  // A list or entry written once under an anchor (`&data`) and reused as `*data` is the
  // same node everywhere: follow the alias, and edit each node once.
  const deref = (node: unknown): unknown => (isAlias(node) ? node.resolve(doc) : node);
  const seen = new Set<unknown>();

  const services = deref(doc.get("services"));
  if (isMap(services)) {
    for (const item of services.items) {
      const service = deref(item.value);
      const volumes = isMap(service) ? deref(service.get("volumes", true)) : null;
      if (!isSeq(volumes)) continue;
      for (const raw of volumes.items) {
        const entry = deref(raw);
        if (seen.has(entry)) continue;
        seen.add(entry);
        if (isScalar(entry) && typeof entry.value === "string") {
          // Short syntax, "source:target[:mode]": only the source is a host path. With no
          // colon, the entry is just a container path (an anonymous volume): not ours.
          const colon = entry.value.indexOf(":");
          if (colon === -1) continue;
          const next = swap(entry.value.slice(0, colon));
          if (next !== null) {
            entry.value = next + entry.value.slice(colon);
            changed = true;
          }
        } else if (isMap(entry)) {
          // `source: *src` is an alias: read what it names. The rewritten path replaces this
          // use only, so the anchor (perhaps under an `x-` key) keeps its own value.
          const source = deref(entry.get("source", true));
          const next = isScalar(source) && typeof source.value === "string" ? swap(source.value) : null;
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
