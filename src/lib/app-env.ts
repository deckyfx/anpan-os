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

/**
 * Where the quote closing a value opened with `quote` is in `body`, or -1.
 *
 * Compose's rule, for both kinds of quote: a quote right after a backslash does not close
 * the value, so `'it\'s'` is one value.
 */
function closingQuote(body: string, quote: string): number {
  for (let i = 0; i < body.length; i++) {
    if (body[i] === quote && body[i - 1] !== "\\") return i;
  }
  return -1;
}

/** One `.env` assignment, its value as written (quotes removed), and how it was quoted. */
interface Assignment {
  key:   string;
  value: string;
  quote: '"' | "'" | null;
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
 * Values are as written: `${VAR}` references are left for {@link resolvedEnvValue}, and
 * escapes inside double quotes are not expanded, which nothing here needs.
 */
function envAssignments(env: string): Assignment[] {
  const out: Assignment[] = [];
  const lines = env.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim().replace(/^export\s+/, "");
    if (!line || line.startsWith("#")) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_.-]*)\s*(?:=|:(?=\s|$))\s*(.*)$/.exec(line);
    if (!m) continue;
    const rest = m[2] ?? "";
    const first = rest[0];
    if (first === '"' || first === "'") {
      let body = rest.slice(1);
      let end = closingQuote(body, first);
      while (end < 0 && i + 1 < lines.length) {
        body += `\n${lines[++i]}`;
        end = closingQuote(body, first);
      }
      out.push({ key: m[1]!, value: end < 0 ? body : body.slice(0, end), quote: first });
    } else {
      out.push({ key: m[1]!, value: rest.split(" #")[0]!.trimEnd(), quote: null });
    }
  }
  return out;
}

/** Keys an `.env` file sets. */
export function envKeys(env: string): Set<string> {
  return new Set(envAssignments(env).map(a => a.key));
}

/** The value `.env` gives `key`, as written; the last assignment wins, as in Compose. Null when unset. */
export function envValue(env: string, key: string): string | null {
  let value: string | null = null;
  for (const a of envAssignments(env)) if (a.key === key) value = a.value;
  return value;
}

/**
 * The value Compose ends up with for `key` from `.env`, references substituted:
 * `PUID=${APP_UID:-2001}` is 2001 when APP_UID is set nowhere.
 *
 * Substituted Compose's way: a name is looked up in `shell` (the environment Compose runs
 * with) first, then in the assignments above it in the file. A single-quoted value is
 * literal. Null when `.env` does not set `key`.
 */
export function resolvedEnvValue(env: string, key: string, shell: Record<string, string | undefined> = process.env): string | null {
  const earlier = new Map<string, string>();
  let value: string | null = null;
  for (const a of envAssignments(env)) {
    const v = a.quote === "'" ? a.value : interpolate(a.value, name => shell[name] ?? earlier.get(name));
    earlier.set(a.key, v);
    if (a.key === key) value = v;
  }
  return value;
}

/**
 * Substitute `$VAR`, `${VAR}` and the default forms `${VAR:-x}`, `${VAR-x}`, `${VAR:+x}`,
 * `${VAR+x}` in `text`, and turn `$$` into `$`. A default may hold references of its own.
 * `${VAR:?msg}` gives the value, or nothing: Compose would refuse the file, and its own
 * check reports that.
 */
export function interpolate(text: string, lookup: (name: string) => string | undefined): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c !== "$") { out += c; continue; }
    const next = text[i + 1];
    if (next === "$") { out += "$"; i++; continue; }
    if (next === "{") {
      // The matching brace, counting nested ones inside a default.
      let depth = 1;
      let j = i + 2;
      for (; j < text.length && depth > 0; j++) {
        if (text[j] === "{") depth++;
        else if (text[j] === "}") depth--;
      }
      if (depth > 0) { out += text.slice(i); break; }
      const m = /^([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-+?])([\s\S]*))?$/.exec(text.slice(i + 2, j - 1));
      if (m) {
        const [, name, op, arg = ""] = m;
        const v = lookup(name!);
        const empty = v === undefined || v === "";
        if (op === ":-")     out += empty ? interpolate(arg, lookup) : v;
        else if (op === "-") out += v === undefined ? interpolate(arg, lookup) : v;
        else if (op === ":+") out += empty ? "" : interpolate(arg, lookup);
        else if (op === "+") out += v === undefined ? "" : interpolate(arg, lookup);
        else out += v ?? "";
      } else {
        out += text.slice(i, j);
      }
      i = j - 1;
      continue;
    }
    const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i + 1))?.[0];
    if (name) { out += lookup(name) ?? ""; i += name.length; continue; }
    out += c;
  }
  return out;
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
