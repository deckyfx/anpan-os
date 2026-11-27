import { parse } from "yaml";
import type { ComposeDocument, ServiceForm, StackConfig, NamedNetwork, NamedVolume } from "./types";

/**
 * Parse compose YAML into plain JS for the form model.
 *
 * Only the read side lives here. Writing form edits back goes through
 * `applyFormChanges` in composePatch.ts, which edits the YAML document in
 * place so everything the form does not model survives.
 */
export function parseComposeDoc(yamlStr: string): ComposeDocument {
  const doc = parse(yamlStr) as Record<string, unknown>;
  if (!doc || typeof doc !== "object") throw new Error("Invalid YAML: expected an object");
  if (!doc.services || typeof doc.services !== "object") throw new Error("Invalid compose file: missing 'services' key");
  return doc as unknown as ComposeDocument;
}

// ─── Placeholder-aware string splitting ──────────────────────────────────────
//
// Compose values carry interpolation placeholders such as `${PORT:-8080}` or
// `${DATA:?missing}`. Those contain ':', '/', '=' and spaces, so a naive
// split on a separator cuts a placeholder in half. These helpers treat every
// character inside `${...}` (nested ones too) as opaque. `$$` is compose's
// escape for a literal '$', so `$${X}` is not a placeholder.

/**
 * Mark which characters of `s` sit inside a `${...}` placeholder.
 *
 * @param s - Raw compose value
 * @returns One flag per character; true means "inside a placeholder"
 */
export function placeholderMask(s: string): boolean[] {
  const mask = new Array<boolean>(s.length).fill(false);
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const n = s[i + 1];
    if (depth > 0) mask[i] = true;
    if (c === "$" && n === "$") {
      // Escaped dollar: consume both so the second one cannot open a placeholder
      if (depth > 0) mask[i + 1] = true;
      i++;
      continue;
    }
    if (c === "$" && n === "{") {
      mask[i] = true;
      mask[i + 1] = true;
      depth++;
      i++;
      continue;
    }
    if (c === "}" && depth > 0) depth--;
  }
  return mask;
}

/**
 * `indexOf` for a single character that skips matches inside `${...}`.
 *
 * @param s    - String to search
 * @param ch   - Single separator character
 * @param from - Start index (default 0)
 * @returns Index of the first match outside a placeholder, or -1
 */
export function indexOfOutsideVars(s: string, ch: string, from = 0): number {
  const mask = placeholderMask(s);
  for (let i = from; i < s.length; i++) if (s[i] === ch && !mask[i]) return i;
  return -1;
}

/**
 * `lastIndexOf` for a single character that skips matches inside `${...}`.
 *
 * @param s  - String to search
 * @param ch - Single separator character
 * @returns Index of the last match outside a placeholder, or -1
 */
export function lastIndexOfOutsideVars(s: string, ch: string): number {
  const mask = placeholderMask(s);
  for (let i = s.length - 1; i >= 0; i--) if (s[i] === ch && !mask[i]) return i;
  return -1;
}

/**
 * `split` on a single character that leaves `${...}` placeholders whole.
 *
 * @param s  - String to split
 * @param ch - Single separator character
 * @returns The parts, as `String.prototype.split` would return them
 */
export function splitOutsideVars(s: string, ch: string): string[] {
  const mask  = placeholderMask(s);
  const parts: string[] = [];
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === ch && !mask[i]) {
      parts.push(s.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(s.slice(start));
  return parts;
}

// ─── Argument lists (command / entrypoint / healthcheck CMD) ─────────────────

/**
 * Split a shell-like argument string into tokens. Supports "double" quotes
 * (with backslash escapes), 'single' quotes and backslash escapes outside
 * quotes. Whitespace inside a `${...}` placeholder does not split.
 *
 * @param s - Argument string as shown in the form
 * @returns The tokens, or null when the quoting is unbalanced
 */
export function splitArgs(s: string): string[] | null {
  const mask   = placeholderMask(s);
  const tokens: string[] = [];
  let cur   = "";
  let inTok = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (mask[i]) { cur += c; inTok = true; continue; }
    if (/\s/.test(c)) {
      if (inTok) { tokens.push(cur); cur = ""; inTok = false; }
      continue;
    }
    inTok = true;
    if (c === "\\") {
      if (i + 1 >= s.length) return null;
      cur += s[++i];
    } else if (c === '"') {
      let closed = false;
      for (i++; i < s.length; i++) {
        const q = s[i]!;
        if (q === "\\" && i + 1 < s.length) { cur += s[++i]; continue; }
        if (q === '"') { closed = true; break; }
        cur += q;
      }
      if (!closed) return null;
    } else if (c === "'") {
      const end = s.indexOf("'", i + 1);
      if (end < 0) return null;
      cur += s.slice(i + 1, end);
      i = end;
    } else {
      cur += c;
    }
  }
  if (inTok) tokens.push(cur);
  return tokens;
}

/**
 * Join an argument array into one editable string, quoting only the elements
 * that would not survive `splitArgs` on their own. This is the inverse of
 * `splitArgs`, so `["sh", "-c", "echo hi"]` shows as `sh -c "echo hi"` and an
 * edit can be split back into the same array.
 *
 * @param args - Argument array from the compose file
 * @returns Display string for the form
 */
export function formatArgs(args: readonly unknown[]): string {
  return args.map(a => {
    const el = String(a ?? "");
    const t  = splitArgs(el);
    if (t && t.length === 1 && t[0] === el) return el;
    return `"${el.replace(/[\\"]/g, "\\$&")}"`;
  }).join(" ");
}

// ─── Shared key=value parser (env, labels) ───────────────────────────────────

/** Split `KEY=VALUE` on the first '=' outside a placeholder. */
function splitKeyValue(item: string): { key: string; value: string | null } {
  const eq = indexOfOutsideVars(item, "=");
  return eq >= 0
    ? { key: item.slice(0, eq), value: item.slice(eq + 1) }
    : { key: item, value: null };
}

/**
 * Parse one list-syntax `KEY=VALUE` item (environment, labels). A bare `KEY`
 * has a null value.
 *
 * @param item - One element of the list
 */
export function parseKeyValueItem(item: unknown): { key: string; value: string | null } {
  return splitKeyValue(String(item ?? ""));
}

function parseKeyValueEntries(raw: unknown): Array<{ key: string; value: string }> {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return (raw as unknown[]).map(item => {
      const { key, value } = splitKeyValue(String(item));
      return { key, value: value ?? "" };
    });
  }
  if (typeof raw === "object") {
    return Object.entries(raw as Record<string, unknown>).map(([key, value]) => ({
      key,
      value: value == null ? "" : String(value),
    }));
  }
  return [];
}

// Env uses null for bare keys ("FOO" = inherit from host vs "FOO=" = explicit empty)
function parseEnvEntries(raw: unknown): Array<{ key: string; value: string | null }> {
  if (!raw) return [];
  if (Array.isArray(raw)) return (raw as unknown[]).map(item => splitKeyValue(String(item)));
  if (typeof raw === "object") {
    return Object.entries(raw as Record<string, unknown>).map(([key, value]) => ({
      key,
      value: value == null ? null : String(value),
    }));
  }
  return [];
}

const parseLabels = parseKeyValueEntries;

// ─── Parse ports ──────────────────────────────────────────────────────────────

type PortEntry = ServiceForm["ports"][number];

/**
 * Parse one entry of a service's `ports` list (short string or long map form).
 * The container port is the part after the last ':' outside a placeholder, so
 * `ip:host:container` keeps `ip:host` together in the host field.
 *
 * @param item - One element of the `ports` sequence
 */
export function parsePortEntry(item: unknown): PortEntry {
  if (typeof item === "string" || typeof item === "number") {
    const str      = String(item);
    const slash    = lastIndexOfOutsideVars(str, "/");
    const protocol = (slash >= 0 && str.slice(slash + 1) === "udp" ? "udp" : "tcp") as PortEntry["protocol"];
    const mapping  = slash >= 0 ? str.slice(0, slash) : str;
    const colonIdx = lastIndexOfOutsideVars(mapping, ":");
    if (colonIdx >= 0) {
      return { host: mapping.slice(0, colonIdx), container: mapping.slice(colonIdx + 1), protocol };
    }
    return { host: "", container: mapping, protocol };
  }
  if (typeof item === "object" && item !== null) {
    const o = item as Record<string, unknown>;
    const host = o.published ?? o.host;
    return {
      host:      host == null ? "" : String(host),
      container: String(o.target ?? o.container ?? ""),
      protocol:  o.protocol === "udp" ? "udp" : "tcp",
    };
  }
  return { host: "", container: String(item ?? ""), protocol: "tcp" };
}

function parsePorts(raw: unknown): PortEntry[] {
  if (!raw || !Array.isArray(raw)) return [];
  return (raw as unknown[]).map(parsePortEntry);
}

// ─── Parse volumes ────────────────────────────────────────────────────────────

type VolumeEntry = ServiceForm["volumes"][number];

/** The access mode among comma-separated mount options (`ro,z` is read-only). */
function toMode(s: string): VolumeEntry["mode"] {
  const opts = s.split(",");
  return opts.includes("ro") ? "ro" : opts.includes("rw") ? "rw" : "";
}

/**
 * Parse one entry of a service's `volumes` list (short string or long map).
 * A single-part string (`/data`) is an anonymous volume, so it is the
 * container path, not the host path.
 *
 * @param item - One element of the `volumes` sequence
 */
export function parseVolumeEntry(item: unknown): VolumeEntry {
  if (typeof item === "string") {
    const parts = splitOutsideVars(item, ":");
    if (parts.length === 1) return { host: "", container: parts[0]!, mode: "" };
    return { host: parts[0] ?? "", container: parts[1] ?? "", mode: toMode(parts.slice(2).join(":")) };
  }
  if (typeof item === "object" && item !== null) {
    const o = item as Record<string, unknown>;
    const mode = toMode(String(o.mode ?? (o.read_only ? "ro" : "")));
    return { host: String(o.source ?? ""), container: String(o.target ?? ""), mode };
  }
  return { host: "", container: String(item ?? ""), mode: "" };
}

function parseVolumes(raw: unknown): VolumeEntry[] {
  if (!raw || !Array.isArray(raw)) return [];
  return (raw as unknown[]).map(parseVolumeEntry);
}

// ─── Parse memory limit ───────────────────────────────────────────────────────

function parseMemStr(raw: string): number {
  const s = raw.trim().toLowerCase();
  const n = parseFloat(s);
  if (isNaN(n)) return 0;
  if (s.endsWith("gb") || s.endsWith("g")) return Math.round(n * 1024);
  if (s.endsWith("mb") || s.endsWith("m")) return Math.round(n);
  if (s.endsWith("kb") || s.endsWith("k")) return Math.round(n / 1024);
  // bare bytes
  return Math.round(n / (1024 * 1024));
}

function parseMemMb(svc: Record<string, unknown>): number {
  if (svc.mem_limit) {
    const v = parseMemStr(String(svc.mem_limit));
    if (v > 0) return v;
  }
  const deploy = svc.deploy as Record<string, unknown> | undefined;
  const limits = deploy?.resources as Record<string, unknown> | undefined;
  const memory = (limits?.limits as Record<string, unknown> | undefined)?.memory;
  if (memory) {
    const v = parseMemStr(String(memory));
    if (v > 0) return v;
  }
  return 0;
}

function parseCpuLimit(svc: Record<string, unknown>): number {
  if (svc.cpus !== undefined) {
    const parsed = parseFloat(String(svc.cpus));
    return isNaN(parsed) ? 0 : parsed;
  }
  const deploy = svc.deploy as Record<string, unknown> | undefined;
  const limits = deploy?.resources as Record<string, unknown> | undefined;
  const cpus   = (limits?.limits as Record<string, unknown> | undefined)?.cpus;
  if (cpus !== undefined) {
    const parsed = parseFloat(String(cpus));
    return isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

// ─── Image references ─────────────────────────────────────────────────────────

/**
 * Split an image reference into name and tag. The tag separator is the last
 * ':' outside a placeholder that comes after the last '/', so a registry
 * port (`localhost:5000/app`) is not mistaken for a tag. A digest reference
 * (`repo@sha256:...`) is kept whole with no tag.
 *
 * @param image - Value of the service's `image` key
 * @returns Name and tag; `tag` is null when the reference has none
 */
export function splitImageRef(image: string): { name: string; tag: string | null } {
  if (indexOfOutsideVars(image, "@") >= 0) return { name: image, tag: null };
  const lastSlash = lastIndexOfOutsideVars(image, "/");
  const lastColon = lastIndexOfOutsideVars(image, ":");
  if (lastColon > lastSlash) return { name: image.slice(0, lastColon), tag: image.slice(lastColon + 1) };
  return { name: image, tag: null };
}

// ─── Healthcheck test ─────────────────────────────────────────────────────────

/**
 * Show a healthcheck `test` as one editable string. `CMD` arrays are joined
 * with `formatArgs` so they split back into the same array; `CMD-SHELL`
 * carries a single shell string; `NONE` shows as empty.
 *
 * @param test - Raw `healthcheck.test` value
 */
export function formatHealthcheckTest(test: unknown): string {
  if (!Array.isArray(test)) return test == null ? "" : String(test);
  const [kind, ...rest] = test as unknown[];
  if (kind === "CMD")       return formatArgs(rest);
  if (kind === "CMD-SHELL") return rest.map(String).join(" ");
  if (kind === "NONE")      return "";
  return formatArgs(test as unknown[]);
}

// ─── String lists that compose also accepts in other shapes ──────────────────

/** `dns` and similar keys accept a single string as well as a list. */
function parseStrArr(raw: unknown): string[] {
  if (raw == null || raw === "") return [];
  if (Array.isArray(raw)) return (raw as unknown[]).map(String);
  if (typeof raw === "string" || typeof raw === "number") return [String(raw)];
  return [];
}

/**
 * `extra_hosts` accepts a list of `host:ip` / `host=ip` strings or a
 * `host: ip` map. The map form is shown as `host:ip` entries.
 */
function parseExtraHosts(raw: unknown): string[] {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return Object.entries(raw as Record<string, unknown>).map(([k, v]) => formatHostEntry(k, v));
  }
  return parseStrArr(raw);
}

/**
 * Format one `extra_hosts` map entry for the form.
 *
 * @param host - Host name (the map key)
 * @param ip   - Address (the map value)
 */
export function formatHostEntry(host: string, ip: unknown): string {
  return ip == null ? host : `${host}:${String(ip)}`;
}

/**
 * Split a form `extra_hosts` entry into host and address, on the first '='
 * or ':' outside a placeholder (an IPv6 address keeps its colons).
 *
 * @param entry - `host:ip` or `host=ip`
 */
export function splitHostEntry(entry: string): { host: string; ip: string | null } {
  const eq    = indexOfOutsideVars(entry, "=");
  const colon = indexOfOutsideVars(entry, ":");
  const cut   = eq >= 0 && (colon < 0 || eq < colon) ? eq : colon;
  return cut >= 0 ? { host: entry.slice(0, cut), ip: entry.slice(cut + 1) } : { host: entry, ip: null };
}

// ─── parseService ─────────────────────────────────────────────────────────────

/**
 * Build the form model for one service from its parsed compose value.
 * Keys the form does not model are ignored here; they stay in the YAML
 * because writes go through `applyFormChanges`.
 *
 * @param svc - The service's value from the parsed compose file
 */
export function parseService(svc: unknown): ServiceForm {
  const s = (svc && typeof svc === "object" ? svc : {}) as Record<string, unknown>;

  const ref       = splitImageRef(String(s.image ?? ""));
  const imageName = ref.name;
  const imageTag  = ref.tag ?? "latest";

  const restart = (["no", "always", "on-failure", "unless-stopped"] as const).includes(s.restart as never)
    ? s.restart as ServiceForm["restart"]
    : "no";

  const networksRaw = s.networks;
  const networks: string[] = Array.isArray(networksRaw)
    ? (networksRaw as unknown[]).map(String)
    : typeof networksRaw === "object" && networksRaw !== null
      ? Object.keys(networksRaw as object)
      : [];

  const dependsOnRaw = s.depends_on;
  const dependsOn: string[] = Array.isArray(dependsOnRaw)
    ? (dependsOnRaw as unknown[]).map(String)
    : typeof dependsOnRaw === "object" && dependsOnRaw !== null
      ? Object.keys(dependsOnRaw as object)
      : [];

  const hc = (s.healthcheck && typeof s.healthcheck === "object" ? s.healthcheck : {}) as Record<string, unknown>;

  // Logging
  const loggingRaw = s.logging as Record<string, unknown> | undefined;
  const loggingDriver = String(loggingRaw?.driver ?? "");
  const loggingOptsRaw = loggingRaw?.options;
  const loggingOptions = loggingOptsRaw && typeof loggingOptsRaw === "object" && !Array.isArray(loggingOptsRaw)
    ? Object.entries(loggingOptsRaw as Record<string, unknown>).map(([key, value]) => ({ key, value: String(value ?? "") }))
    : [];

  const args = (raw: unknown): string =>
    Array.isArray(raw) ? formatArgs(raw as unknown[]) : raw == null ? "" : String(raw);

  return {
    imageName,
    imageTag,
    restart,
    containerName: String(s.container_name ?? ""),
    ports:        parsePorts(s.ports),
    environment:  parseEnvEntries(s.environment),
    volumes:      parseVolumes(s.volumes),
    networks,
    dependsOn,
    privileged:   s.privileged === true,
    memLimitMb:   parseMemMb(s),
    cpuLimit:     parseCpuLimit(s),
    command:      args(s.command),
    entrypoint:   args(s.entrypoint),
    healthcheckTest:     formatHealthcheckTest(hc.test),
    healthcheckInterval: String(hc.interval ?? ""),
    healthcheckTimeout:  String(hc.timeout ?? ""),
    healthcheckRetries:  typeof hc.retries === "number" ? hc.retries : 0,

    networkMode:  String(s.network_mode ?? ""),
    labels:       parseLabels(s.labels),
    capAdd:       parseStrArr(s.cap_add),
    capDrop:      parseStrArr(s.cap_drop),
    devices:      parseStrArr(s.devices),
    extraHosts:   parseExtraHosts(s.extra_hosts),
    dns:          parseStrArr(s.dns),
    logging:      { driver: loggingDriver, options: loggingOptions },
    stdinOpen:    s.stdin_open === true,
    tty:          s.tty === true,
    user:         String(s.user ?? ""),
    workingDir:   String(s.working_dir ?? ""),
  };
}

// ─── Form value formatting (shared with composePatch) ────────────────────────

/** Short-syntax string for a port entry. */
export function formatPort({ host, container, protocol }: PortEntry): string {
  const base = host ? `${host}:${container}` : container;
  return protocol === "udp" ? `${base}/udp` : base;
}

/**
 * Short-syntax string for a volume entry.
 *
 * @param v      - Form entry
 * @param suffix - Original mode part to keep verbatim (e.g. `ro,z`); used
 *                 instead of `v.mode` when given
 */
export function formatVolume(v: VolumeEntry, suffix?: string): string {
  let s = v.host ? `${v.host}:${v.container}` : v.container;
  const mode = suffix ?? v.mode;
  if (mode) s += `:${mode}`;
  return s;
}

/**
 * Compose value for a volume entry: the short-syntax string, except for a
 * read-only anonymous volume. `/data:ro` would read as source `/data` and
 * target `ro`, so that one is written in long syntax.
 *
 * @param v      - Form entry
 * @param suffix - Original options part to keep verbatim, as for `formatVolume`
 */
export function volumeItem(v: VolumeEntry, suffix?: string): string | Record<string, unknown> {
  if (v.host) return formatVolume(v, suffix);
  // rw is the default, and other options have no short form without a source
  return toMode(suffix ?? v.mode) === "ro" ? { type: "volume", target: v.container, read_only: true } : v.container;
}

/** List-syntax string for an environment entry (`KEY` inherits from the host). */
export function formatEnv({ key, value }: { key: string; value: string | null }): string {
  return value === null ? key : `${key}=${value}`;
}

/** List-syntax string for a label entry. */
export function formatLabel({ key, value }: { key: string; value: string }): string {
  return value ? `${key}=${value}` : key;
}

/**
 * Image reference for the form's name and tag. A `latest` tag is left
 * implicit unless the file already spelled it out.
 *
 * @param name        - Image name (may be a whole digest reference)
 * @param tag         - Tag from the form
 * @param explicitTag - Whether the current reference carries a tag
 */
export function formatImage(name: string, tag: string, explicitTag = false): string {
  if (!name) return "";
  if (indexOfOutsideVars(name, "@") >= 0) return name;
  return tag && (tag !== "latest" || explicitTag) ? `${name}:${tag}` : name;
}

/**
 * Drop half-filled rows the form keeps while the user types (an added row
 * with no key, an empty list item) so they are not written as junk.
 *
 * @param form - Service form as edited
 * @returns A copy with empty rows removed
 */
export function cleanServiceForm(form: ServiceForm): ServiceForm {
  const nonEmpty = (xs: string[]) => xs.map(x => x.trim()).filter(Boolean);
  return {
    ...form,
    ports:       form.ports.filter(p => p.container.trim() !== ""),
    environment: form.environment.filter(e => e.key.trim() !== ""),
    // A mount needs a target; an anonymous one needs nothing else
    volumes:     form.volumes.filter(v => v.container.trim() !== ""),
    labels:      form.labels.filter(l => l.key.trim() !== ""),
    networks:    nonEmpty(form.networks),
    dependsOn:   nonEmpty(form.dependsOn),
    capAdd:      nonEmpty(form.capAdd),
    capDrop:     nonEmpty(form.capDrop),
    devices:     nonEmpty(form.devices),
    extraHosts:  nonEmpty(form.extraHosts),
    dns:         nonEmpty(form.dns),
    logging:     { ...form.logging, options: form.logging.options.filter(o => o.key.trim() !== "") },
  };
}

// ─── serializeService ─────────────────────────────────────────────────────────

/**
 * Build a whole service value from a form. Only used for a service that does
 * not exist in the YAML yet; existing services are patched in place.
 *
 * @param raw - Service form
 */
export function serializeService(raw: ServiceForm): Record<string, unknown> {
  const form = cleanServiceForm(raw);
  const out: Record<string, unknown> = {};

  const image = formatImage(form.imageName, form.imageTag);
  if (image) out.image = image;

  if (form.restart && form.restart !== "no") out.restart = form.restart;
  if (form.containerName) out.container_name = form.containerName;
  if (form.networkMode)   out.network_mode   = form.networkMode;
  if (form.user)          out.user           = form.user;
  if (form.workingDir)    out.working_dir    = form.workingDir;
  if (form.stdinOpen)     out.stdin_open     = true;
  if (form.tty)           out.tty            = true;
  if (form.privileged)    out.privileged     = true;

  if (form.ports.length > 0)       out.ports       = form.ports.map(formatPort);
  if (form.environment.length > 0) out.environment = form.environment.map(formatEnv);
  if (form.labels.length > 0)      out.labels      = form.labels.map(formatLabel);
  if (form.volumes.length > 0)     out.volumes     = form.volumes.map(v => volumeItem(v));

  if (form.networks.length > 0) out.networks = form.networks;
  if (form.dependsOn.length > 0) out.depends_on = form.dependsOn;

  if (form.capAdd.length > 0)     out.cap_add     = form.capAdd;
  if (form.capDrop.length > 0)    out.cap_drop    = form.capDrop;
  if (form.devices.length > 0)    out.devices     = form.devices;
  if (form.extraHosts.length > 0) out.extra_hosts = form.extraHosts;
  if (form.dns.length > 0)        out.dns         = form.dns;

  if (form.logging.driver || form.logging.options.length > 0) {
    const loggingOut: Record<string, unknown> = {};
    if (form.logging.driver) loggingOut.driver = form.logging.driver;
    if (form.logging.options.length > 0) {
      loggingOut.options = Object.fromEntries(
        form.logging.options.map(({ key, value }) => [key, value])
      );
    }
    out.logging = loggingOut;
  }

  // Resource limits (v3 format)
  if (form.memLimitMb > 0 || form.cpuLimit > 0) {
    const limits: Record<string, unknown> = {};
    if (form.memLimitMb > 0) limits.memory = `${form.memLimitMb}m`;
    if (form.cpuLimit > 0) limits.cpus = String(form.cpuLimit);
    out.deploy = { resources: { limits } };
  }

  if (form.command)    out.command    = form.command;
  if (form.entrypoint) out.entrypoint = form.entrypoint;

  if (form.healthcheckTest || form.healthcheckInterval || form.healthcheckTimeout || form.healthcheckRetries > 0) {
    const hc: Record<string, unknown> = {};
    if (form.healthcheckTest)     hc.test     = ["CMD-SHELL", form.healthcheckTest];
    if (form.healthcheckInterval) hc.interval = form.healthcheckInterval;
    if (form.healthcheckTimeout)  hc.timeout  = form.healthcheckTimeout;
    if (form.healthcheckRetries > 0) hc.retries = form.healthcheckRetries;
    out.healthcheck = hc;
  }

  return out;
}

// ─── Stack-level networks/volumes ─────────────────────────────────────────────

/**
 * Form entry for one top-level network.
 *
 * @param name - Network key
 * @param raw  - Its value (null for `name:`)
 */
export function parseNamedNetwork(name: string, raw: unknown): NamedNetwork {
  const n = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    name,
    driver:     String(n.driver ?? ""),
    external:   n.external === true || (typeof n.external === "object" && n.external !== null),
    attachable: n.attachable === true,
  };
}

/**
 * Form entry for one top-level volume.
 *
 * @param name - Volume key
 * @param raw  - Its value (null for `name:`)
 */
export function parseNamedVolume(name: string, raw: unknown): NamedVolume {
  const v = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const driverOptsRaw = v.driver_opts;
  const driverOpts = driverOptsRaw && typeof driverOptsRaw === "object" && !Array.isArray(driverOptsRaw)
    ? Object.entries(driverOptsRaw as Record<string, unknown>).map(([key, value]) => ({ key, value: String(value ?? "") }))
    : [];
  return {
    name,
    driver:     String(v.driver ?? ""),
    external:   v.external === true || (typeof v.external === "object" && v.external !== null),
    driverOpts,
  };
}

/**
 * Build the Stack Config form (name, named networks and volumes).
 *
 * @param doc - Parsed compose file
 */
export function parseStackConfig(doc: ComposeDocument): StackConfig {
  const networks: NamedNetwork[] = [];
  const volumes:  NamedVolume[]  = [];

  if (doc.networks && typeof doc.networks === "object") {
    for (const [name, raw] of Object.entries(doc.networks as Record<string, unknown>)) {
      networks.push(parseNamedNetwork(name, raw));
    }
  }

  if (doc.volumes && typeof doc.volumes === "object") {
    for (const [name, raw] of Object.entries(doc.volumes as Record<string, unknown>)) {
      volumes.push(parseNamedVolume(name, raw));
    }
  }

  return { name: String((doc as unknown as Record<string, unknown>).name ?? ""), networks, volumes };
}
