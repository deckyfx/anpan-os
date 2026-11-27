/**
 * Apply guided-form edits to compose YAML in place.
 *
 * The form models only part of a compose file. Rebuilding the file from the
 * form drops everything else (x-casaos metadata, ulimits, sysctls, comments,
 * long-form depends_on, CMD healthchecks...), and the App Store installs real
 * CasaOS files through this editor. So instead of rebuilding, we:
 *
 *   1. diff the form as it was last read from the YAML (`base`) against the
 *      form now (`next`), field by field;
 *   2. for each changed field only, edit that node of the parsed YAML
 *      Document, in the shape the file already uses (list vs map, string vs
 *      array, long vs short syntax, quoting);
 *   3. print the Document and splice only the changed lines back into the
 *      original text, so untouched lines stay byte-for-byte.
 */
import {
  isAlias, isMap, isNode, isPair, isScalar, isSeq, parse, parseDocument,
  Scalar, YAMLMap, YAMLSeq,
  type Document, type Pair, type ToStringOptions,
} from "yaml";
import {
  cleanServiceForm, formatEnv, formatHostEntry, formatImage, formatLabel, formatPort,
  lastIndexOfOutsideVars, parseKeyValueItem, parseNamedNetwork, parseNamedVolume, parsePortEntry, parseService,
  parseVolumeEntry, serializeService, splitArgs, splitHostEntry, splitImageRef, splitOutsideVars, volumeItem,
} from "./composeUtils";
import type { NamedNetwork, NamedVolume, ServiceForm, StackConfig } from "./types";

/** The form state the dialog keeps: services in tab order plus stack config. */
export interface FormSnapshot {
  serviceNames: string[];
  serviceForms: Record<string, ServiceForm>;
  stackConfig:  StackConfig;
}

type Doc     = Document.Parsed;
type Path    = ReadonlyArray<string | number>;
type Prim    = string | number | boolean | null;
type AnyPair = Pair<unknown, unknown>;

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

// ═══ Public entry point ══════════════════════════════════════════════════════

/**
 * Write form edits into compose YAML without touching anything else.
 *
 * Only fields that differ between `base` and `next` are written, so a field
 * the user did not change is never rewritten, and YAML edited by hand since
 * `base` was read keeps those edits. When nothing differs the input text is
 * returned unchanged.
 *
 * @param yamlText - Current compose YAML (the source of truth)
 * @param base     - Form state as last read from (or written to) the YAML
 * @param next     - Form state now
 * @param renames  - Services renamed in the form, old name → new name; a
 *                   renamed service keeps all of its other keys
 * @returns The updated YAML text
 * @throws When `yamlText` is not valid YAML or not a mapping, or when an
 *         array `command`/`entrypoint` is edited to a string with
 *         unbalanced quotes (the YAML is then left as it was)
 */
export function applyFormChanges(
  yamlText: string,
  base:     FormSnapshot,
  next:     FormSnapshot,
  renames:  Readonly<Record<string, string>> = {},
): string {
  const doc = parseDocument(yamlText);
  if (doc.errors.length > 0) throw new Error(doc.errors[0]!.message);
  if (!isMap(doc.contents)) throw new Error("Invalid compose file: expected a mapping at the top level");

  const before = JSON.stringify(doc.toJS());
  patchStackName(doc, base.stackConfig.name, next.stackConfig.name);
  patchServices(doc, base, next, renames);
  patchTopLevelNetworks(doc, base.stackConfig.networks, next.stackConfig.networks);
  patchTopLevelVolumes(doc, base.stackConfig.volumes, next.stackConfig.volumes);
  if (JSON.stringify(doc.toJS()) === before) return yamlText;

  return printPreservingSource(yamlText, doc);
}

// ═══ Low-level node helpers ══════════════════════════════════════════════════

/** Plain JS value of a node; the document is needed to resolve aliases. */
function js(doc: Doc, node: unknown): unknown {
  return isNode(node) ? node.toJS(doc) : node;
}

/**
 * Coerce a form string to the type the file already uses, so `PUID: 1000`
 * edited to 1001 stays a number rather than becoming `"1001"`.
 */
function coerceLike(prev: unknown, value: Prim): Prim {
  if (typeof value !== "string") return value;
  // Only when the number prints back as typed: `001` or `1.50` must stay what the user entered
  if (typeof prev === "number" && String(Number(value)) === value) return Number(value);
  if (typeof prev === "boolean" && (value === "true" || value === "false")) return value === "true";
  return value;
}

/** A new scalar node styled like a sibling (e.g. double-quoted like its neighbours). */
function styledNode(doc: Doc, value: unknown, template: unknown): unknown {
  const node = doc.createNode(value);
  if (isScalar(node) && isScalar(template) && typeof node.value === "string" && typeof template.value === "string") {
    if (template.type === Scalar.QUOTE_DOUBLE || template.type === Scalar.QUOTE_SINGLE) node.type = template.type;
  }
  return node;
}

/** Replace a scalar's value in place (keeping its quoting), or return a new node. */
function updateScalarNode(doc: Doc, node: unknown, value: Prim): unknown {
  if (isScalar(node)) {
    node.value = coerceLike(node.value, value);
    return node;
  }
  return doc.createNode(value);
}

/** Set `key` in a map, editing the existing scalar (and its quoting) when there is one. */
function putScalar(doc: Doc, map: YAMLMap<unknown, unknown>, key: string, value: Prim): void {
  const node = map.get(key, true);
  if (isScalar(node)) node.value = coerceLike(node.value, value);
  else map.set(doc.createNode(key), doc.createNode(value));
}

/** Make sure every collection above `path` is a map, so `setIn` can descend. */
function ensureParents(doc: Doc, path: Path): void {
  for (let i = 1; i < path.length; i++) {
    const sub  = path.slice(0, i);
    const node = doc.getIn(sub, true);
    if (node !== undefined && !isMap(node) && !isSeq(node)) doc.setIn(sub, new YAMLMap());
  }
}

/** Set a scalar at `path`, editing the existing node when there is one. */
function setScalar(doc: Doc, path: Path, value: Prim): void {
  const node = doc.getIn(path, true);
  if (isScalar(node)) {
    node.value = coerceLike(node.value, value);
    return;
  }
  ensureParents(doc, path);
  doc.setIn(path, value);
}

/** Set any value at `path` (a whole new collection, say). */
function setValue(doc: Doc, path: Path, value: unknown): void {
  ensureParents(doc, path);
  doc.setIn(path, doc.createNode(value));
}

/**
 * Delete `path`, then remove parent maps left empty by it, but never above
 * `keepDepth` (the service itself stays even if it ends up empty).
 */
function deletePath(doc: Doc, path: Path, keepDepth: number): void {
  if (!doc.hasIn(path)) return;
  doc.deleteIn(path);
  for (let len = path.length - 1; len > keepDepth; len--) {
    const parent = doc.getIn(path.slice(0, len), true);
    if (!isMap(parent) || parent.items.length > 0) break;
    doc.deleteIn(path.slice(0, len));
  }
}

/** Set the key of a map pair, keeping the key node's style when possible. */
function renamePair(doc: Doc, pair: AnyPair, key: string): void {
  if (isScalar(pair.key)) pair.key.value = key;
  else pair.key = doc.createNode(key);
}

function pairKey(doc: Doc, pair: AnyPair): string {
  return String(js(doc, pair.key) ?? "");
}

// ═══ List alignment ══════════════════════════════════════════════════════════

type Edit =
  | { kind: "keep";   from: number; to: number }
  | { kind: "change"; from: number; to: number }
  | { kind: "remove"; from: number }
  | { kind: "add";    to: number };

/**
 * Longest common subsequence of two string arrays, as matched index pairs.
 * Common prefix and suffix are matched first so a small edit to a long list
 * stays cheap. Returns null when the remaining table would be too large.
 */
function lcsPairs(a: readonly string[], b: readonly string[], maxCells = 4_000_000): Array<[number, number]> | null {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;

  const n = a.length - pre - suf;
  const m = b.length - pre - suf;
  if (n * m > maxCells) return null;

  // dp[i][j] = LCS length of a[pre+i..] and b[pre+j..] (flattened)
  const w  = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = a[pre + i] === b[pre + j]
        ? dp[(i + 1) * w + j + 1]! + 1
        : Math.max(dp[(i + 1) * w + j]!, dp[i * w + j + 1]!);
    }
  }

  const out: Array<[number, number]> = [];
  for (let k = 0; k < pre; k++) out.push([k, k]);
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[pre + i] === b[pre + j]) { out.push([pre + i, pre + j]); i++; j++; }
    else if (dp[(i + 1) * w + j]! >= dp[i * w + j + 1]!) i++;
    else j++;
  }
  for (let k = 0; k < suf; k++) out.push([a.length - suf + k, b.length - suf + k]);
  return out;
}

/**
 * Edit script turning `cur` into `next`. Unchanged entries are kept; between
 * two kept entries, removed and added entries are paired up as in-place
 * changes so an edited row keeps its node (comments, long syntax, quoting).
 */
function alignEntries<T>(cur: readonly T[], next: readonly T[]): Edit[] {
  const keyOf  = (x: T) => JSON.stringify(x);
  const anchors = lcsPairs(cur.map(keyOf), next.map(keyOf), Number.POSITIVE_INFINITY)!;
  const edits: Edit[] = [];
  let ci = 0, ni = 0;
  const flush = (cEnd: number, nEnd: number) => {
    while (ci < cEnd && ni < nEnd) edits.push({ kind: "change", from: ci++, to: ni++ });
    while (ci < cEnd) edits.push({ kind: "remove", from: ci++ });
    while (ni < nEnd) edits.push({ kind: "add", to: ni++ });
  };
  for (const [c, n] of anchors) {
    flush(c, n);
    edits.push({ kind: "keep", from: ci++, to: ni++ });
  }
  flush(cur.length, next.length);
  return edits;
}

/** How to read, update and create the items of one YAML collection. */
interface ItemCodec<T> {
  /** Form entry currently represented by an item (a seq node or a map pair). */
  read(item: unknown): T;
  /** Edit an existing item to represent `next`; returns the item to keep. */
  update(item: unknown, cur: T, next: T): unknown;
  /** A new item for `next`; `template` is the last existing item, for style. */
  create(next: T, template: unknown): unknown;
}

/**
 * Patch a seq's or map's items to represent `next`, keeping untouched items
 * as they are. The form's own edits (`base` → `next`) are applied to the
 * items as they are now, so a row edited, added or deleted by hand in the
 * YAML since `base` was read keeps that edit unless the form changed the
 * same row. Without `base` the current items are the base.
 */
function patchItems<T>(coll: YAMLSeq<unknown> | YAMLMap<unknown, unknown>, next: readonly T[], codec: ItemCodec<T>, base?: readonly T[]): void {
  const items    = coll.items as unknown[];
  const cur      = items.map(it => codec.read(it));
  const template = items[items.length - 1];
  const from     = base ?? cur;

  // What the form did to each base row, and the rows it added after each one (-1: before the first)
  const fate  = new Array<Edit>(from.length);
  const added = new Map<number, number[]>();
  let after = -1;
  for (const e of alignEntries(from, next)) {
    if (e.kind === "add") added.set(after, [...(added.get(after) ?? []), e.to]);
    else { fate[e.from] = e; after = e.from; }
  }

  const out: unknown[] = [];
  const pushAdded = (at: number) => { for (const j of added.get(at) ?? []) out.push(codec.create(next[j]!, template)); };
  pushAdded(-1);
  // Walk the rows in their current order and apply the form's edit to each
  for (const e of alignEntries(from, cur)) {
    if (e.kind === "add") { out.push(items[e.to]); continue; } // added by hand
    const f = fate[e.from]!;
    if (e.kind === "remove") {
      // Deleted by hand: only an edit to that row in the form brings it back
      if (f.kind === "change") out.push(codec.create(next[f.to]!, template));
    } else if (f.kind === "keep") {
      out.push(items[e.to]);
    } else if (f.kind === "change") {
      out.push(codec.update(items[e.to], cur[e.to]!, next[f.to]!));
    }
    pushAdded(e.from);
  }
  (coll as { items: unknown[] }).items = out;
}

/** Codecs for a list-valued field that may be a seq, a map, or a lone scalar in the file. */
interface FieldCodecs<T> {
  /** Omitted for fields that are only ever maps; a seq there is replaced. */
  seq?:    ItemCodec<T>;
  map?:    ItemCodec<T>;
  /** Write a single entry as a plain scalar when the file already uses one. */
  scalar?: (entry: T) => Prim;
  /** Value for a field that does not exist yet (the default shape). */
  fresh:   (entries: readonly T[]) => unknown;
}

/**
 * Patch a list-valued field in whatever shape the file uses for it. `base`
 * holds the rows as last read, cleaned the same way as `next`.
 */
function patchListField<T>(doc: Doc, path: Path, base: readonly T[], next: readonly T[], codecs: FieldCodecs<T>, keepDepth: number): void {
  if (next.length === 0) { deletePath(doc, path, keepDepth); return; }
  const node = doc.getIn(path, true);
  if (isSeq(node) && codecs.seq) { patchItems(node, next, codecs.seq, base); return; }
  if (isMap(node) && codecs.map) { patchItems(node, next, codecs.map, base); return; }
  if (isScalar(node) && codecs.scalar && next.length === 1) { node.value = coerceLike(node.value, codecs.scalar(next[0]!)); return; }
  setValue(doc, path, codecs.fresh(next));
}

/** Codec for a seq of plain strings. */
function stringSeqCodec(doc: Doc): ItemCodec<string> {
  return {
    read:   item => String(js(doc, item) ?? ""),
    update: (item, _cur, next) => updateScalarNode(doc, item, next),
    create: (next, template) => styledNode(doc, next, template),
  };
}

/**
 * Codec for a map whose keys are the entries (`depends_on`, a service's
 * `networks`). A changed key is another entry, so it gets a fresh value
 * rather than inheriting the old one (`db`'s `service_healthy` must not
 * carry over to `cache`).
 */
function keyOnlyMapCodec(doc: Doc, newValue: () => unknown): ItemCodec<string> {
  return {
    read:   item => pairKey(doc, item as AnyPair),
    update: (item, _cur, next) => {
      const pair = item as AnyPair;
      renamePair(doc, pair, next);
      pair.value = doc.createNode(newValue());
      return pair;
    },
    create: next => doc.createPair(next, newValue()),
  };
}

/** Codec for a `key: value` map edited as a list of `{ key, value }` rows. */
function keyValueMapCodec<V extends string | null>(doc: Doc, toValue: (raw: unknown) => V): ItemCodec<{ key: string; value: V }> {
  return {
    read: item => {
      const pair = item as AnyPair;
      return { key: pairKey(doc, pair), value: toValue(js(doc, pair.value)) };
    },
    update: (item, cur, next) => {
      const pair = item as AnyPair;
      if (cur.key !== next.key) renamePair(doc, pair, next.key);
      if (cur.value !== next.value) {
        pair.value = next.value === null ? doc.createNode(null) : updateScalarNode(doc, pair.value, next.value);
      }
      return pair;
    },
    create: next => doc.createPair(next.key, next.value),
  };
}

/** Keep the last row for each key: a YAML map cannot hold a key twice. */
function dedupeBy<T>(rows: readonly T[], keyOf: (row: T) => string): T[] {
  const last = new Map<string, number>();
  rows.forEach((r, i) => last.set(keyOf(r), i));
  return rows.filter((r, i) => last.get(keyOf(r)) === i);
}

const byKey  = (r: { key: string }) => r.key;
const byName = (r: { name: string }) => r.name;

/** True when the node at `path` is a map (so keyed rows must be deduplicated). */
function isMapAt(doc: Doc, path: Path): boolean {
  return isMap(doc.getIn(path, true));
}

// ═══ Stack-level fields ══════════════════════════════════════════════════════

/** Top-level `name:`; a new one goes first, where `docker compose` users expect it. */
function patchStackName(doc: Doc, base: string, next: string): void {
  if (base === next) return;
  if (!next) { deletePath(doc, ["name"], 0); return; }
  if (doc.has("name")) { setScalar(doc, ["name"], next); return; }
  (doc.contents as YAMLMap<unknown, unknown>).items.unshift(doc.createPair("name", next));
}

function networkValue(n: NamedNetwork): Record<string, unknown> | null {
  if (n.external) return { external: true };
  const entry: Record<string, unknown> = {};
  if (n.driver)     entry.driver     = n.driver;
  if (n.attachable) entry.attachable = true;
  return Object.keys(entry).length > 0 ? entry : null;
}

function volumeValue(v: NamedVolume): Record<string, unknown> | null {
  if (v.external) return { external: true };
  const entry: Record<string, unknown> = {};
  if (v.driver) entry.driver = v.driver;
  if (v.driverOpts.length > 0) entry.driver_opts = Object.fromEntries(v.driverOpts.map(({ key, value }) => [key, value]));
  return Object.keys(entry).length > 0 ? entry : null;
}

/**
 * Edit the map value of a top-level network/volume pair key by key. A `name:`
 * (null) value becomes a map when a key is needed, and an emptied map goes
 * back to null.
 */
function withEntryMap(doc: Doc, pair: AnyPair, edit: (put: (k: string, v: Prim) => void, drop: (k: string) => void, map: () => YAMLMap<unknown, unknown>) => void): void {
  const map = (): YAMLMap<unknown, unknown> => {
    if (!isMap(pair.value)) pair.value = new YAMLMap();
    return pair.value as YAMLMap<unknown, unknown>;
  };
  const put  = (k: string, v: Prim) => putScalar(doc, map(), k, v);
  const drop = (k: string) => { if (isMap(pair.value)) pair.value.delete(k); };
  edit(put, drop, map);
  if (isMap(pair.value) && pair.value.items.length === 0) pair.value = doc.createNode(null);
}

/** Compose rejects an external network or volume with any attribute besides `name`. */
function dropAllButName(doc: Doc, map: YAMLMap<unknown, unknown>, drop: (k: string) => void): void {
  for (const p of [...map.items]) {
    const k = pairKey(doc, p as AnyPair);
    if (k !== "name" && k !== "external") drop(k);
  }
}

/** Top-level networks as the form lists them: named, one row per name. */
const cleanNetworks = (rows: readonly NamedNetwork[]) => dedupeBy(rows.filter(n => n.name.trim() !== ""), byName);
const cleanVolumes  = (rows: readonly NamedVolume[])  => dedupeBy(rows.filter(v => v.name.trim() !== ""), byName);

function patchTopLevelNetworks(doc: Doc, base: readonly NamedNetwork[], nextRaw: readonly NamedNetwork[]): void {
  if (same(base, nextRaw)) return;
  const next = cleanNetworks(nextRaw);
  patchListField<NamedNetwork>(doc, ["networks"], cleanNetworks(base), next, {
    map: {
      read:   item => parseNamedNetwork(pairKey(doc, item as AnyPair), js(doc, (item as AnyPair).value)),
      update: (item, cur, nx) => {
        const pair = item as AnyPair;
        if (cur.name !== nx.name) renamePair(doc, pair, nx.name);
        withEntryMap(doc, pair, (put, drop, map) => {
          if (cur.external !== nx.external) {
            if (nx.external) { put("external", true); dropAllButName(doc, map(), drop); }
            else drop("external");
          }
          if (nx.external) return;
          if (cur.driver !== nx.driver) { if (nx.driver) put("driver", nx.driver); else drop("driver"); }
          if (cur.attachable !== nx.attachable) { if (nx.attachable) put("attachable", true); else drop("attachable"); }
        });
        return pair;
      },
      create: nx => doc.createPair(nx.name, networkValue(nx)),
    },
    fresh: entries => Object.fromEntries(entries.map(n => [n.name, networkValue(n)])),
  }, 0);
}

function patchTopLevelVolumes(doc: Doc, base: readonly NamedVolume[], nextRaw: readonly NamedVolume[]): void {
  if (same(base, nextRaw)) return;
  const next = cleanVolumes(nextRaw);
  patchListField<NamedVolume>(doc, ["volumes"], cleanVolumes(base), next, {
    map: {
      read:   item => parseNamedVolume(pairKey(doc, item as AnyPair), js(doc, (item as AnyPair).value)),
      update: (item, cur, nx) => {
        const pair = item as AnyPair;
        if (cur.name !== nx.name) renamePair(doc, pair, nx.name);
        withEntryMap(doc, pair, (put, drop, map) => {
          if (cur.external !== nx.external) {
            if (nx.external) { put("external", true); dropAllButName(doc, map(), drop); }
            else drop("external");
          }
          if (nx.external) return;
          if (cur.driver !== nx.driver) { if (nx.driver) put("driver", nx.driver); else drop("driver"); }
          if (!same(cur.driverOpts, nx.driverOpts)) {
            const opts = dedupeBy(nx.driverOpts.filter(o => o.key.trim() !== ""), byKey);
            if (opts.length === 0) { drop("driver_opts"); return; }
            const node = map().get("driver_opts", true);
            if (isMap(node)) patchItems(node, opts, keyValueMapCodec(doc, raw => String(raw ?? "")));
            else map().set(doc.createNode("driver_opts"), doc.createNode(Object.fromEntries(opts.map(o => [o.key, o.value]))));
          }
        });
        return pair;
      },
      create: nx => doc.createPair(nx.name, volumeValue(nx)),
    },
    fresh: entries => Object.fromEntries(entries.map(v => [v.name, volumeValue(v)])),
  }, 0);
}

// ═══ Services ════════════════════════════════════════════════════════════════

function patchServices(doc: Doc, base: FormSnapshot, next: FormSnapshot, renames: Readonly<Record<string, string>>): void {
  if (same(base.serviceNames, next.serviceNames) && same(base.serviceForms, next.serviceForms) && Object.keys(renames).length === 0) return;

  let services = doc.get("services", true);
  if (!isMap(services)) {
    doc.set("services", new YAMLMap());
    services = doc.get("services", true);
  }
  const svcMap = services as YAMLMap<unknown, unknown>;

  // Renames first, so the renamed pair keeps its place and all of its keys
  const renamedFrom: Record<string, string> = {};
  for (const [from, to] of Object.entries(renames)) {
    if (from === to || !next.serviceNames.includes(to) || svcMap.has(to)) continue;
    const pair = svcMap.items.find(p => isPair(p) && pairKey(doc, p) === from);
    if (!pair) continue;
    renamePair(doc, pair, to);
    renamedFrom[to] = from;
  }

  const renamedAway = new Set(Object.values(renamedFrom));
  for (const name of base.serviceNames) {
    if (!next.serviceNames.includes(name) && !renamedAway.has(name)) svcMap.delete(name);
  }

  for (const name of next.serviceNames) {
    const nextForm = next.serviceForms[name];
    if (!nextForm) continue;
    const baseName = renamedFrom[name] ?? name;
    const baseForm = base.serviceNames.includes(baseName) ? base.serviceForms[baseName] : undefined;
    const node     = svcMap.get(name, true);
    if (node === undefined) {
      // Not in the YAML. Write it when the form added it or edited it; an
      // untouched one was deleted by hand in the YAML tab and stays deleted.
      if (!baseForm || !same(baseForm, nextForm)) svcMap.set(doc.createNode(name), doc.createNode(serializeService(nextForm)));
      continue;
    }
    const curForm = parseService(js(doc, node));
    // Untouched: leave the node as it is, which matters when it is not a plain map (`worker: *base`)
    if (same(baseForm ?? curForm, nextForm)) continue;
    if (!isMap(node)) {
      // An aliased service is edited as a local copy, so the shared anchor and its other users stay as they are
      const value = js(doc, node);
      svcMap.set(name, isAlias(node) && value !== null && typeof value === "object" && !Array.isArray(value)
        ? doc.createNode(value, { aliasDuplicateObjects: false })
        : new YAMLMap());
    }
    patchService(doc, name, baseForm ?? curForm, nextForm);
  }
}

/**
 * Patch one existing service: every field that differs between `base` and
 * `next` is written in the shape the file already uses for it.
 */
function patchService(doc: Doc, name: string, base: ServiceForm, nextRaw: ServiceForm): void {
  if (same(base, nextRaw)) return;
  const next = cleanServiceForm(nextRaw);
  const old  = cleanServiceForm(base); // list fields are diffed old → next, row by row
  const svc  = ["services", name] as const;
  const at   = (...p: Array<string | number>): Path => [...svc, ...p];
  const KEEP = svc.length; // never prune the service itself
  const changed = <K extends keyof ServiceForm>(...keys: K[]) => keys.some(k => !same(base[k], nextRaw[k]));
  const str  = (key: string, value: string) => value ? setScalar(doc, at(key), value) : deletePath(doc, at(key), KEEP);
  const flag = (key: string, value: boolean) => value ? setScalar(doc, at(key), true) : deletePath(doc, at(key), KEEP);

  if (changed("imageName", "imageTag")) {
    const curImage = String(js(doc, doc.getIn(at("image"), true)) ?? "");
    const image    = formatImage(next.imageName, next.imageTag, splitImageRef(curImage).tag !== null);
    str("image", image);
  }
  if (changed("restart")) {
    if (next.restart === "no" && String(js(doc, doc.getIn(at("restart"), true)) ?? "") !== "no") deletePath(doc, at("restart"), KEEP);
    else setScalar(doc, at("restart"), next.restart);
  }
  if (changed("containerName")) str("container_name", next.containerName);
  if (changed("networkMode"))   str("network_mode",   next.networkMode);
  if (changed("user"))          str("user",           next.user);
  if (changed("workingDir"))    str("working_dir",    next.workingDir);
  if (changed("privileged"))    flag("privileged",    next.privileged);
  if (changed("stdinOpen"))     flag("stdin_open",    next.stdinOpen);
  if (changed("tty"))           flag("tty",           next.tty);

  if (changed("ports"))       patchPorts(doc, at("ports"), old.ports, next.ports, KEEP);
  if (changed("environment")) patchEnvironment(doc, at("environment"), old.environment, next.environment, KEEP);
  if (changed("labels"))      patchLabels(doc, at("labels"), old.labels, next.labels, KEEP);
  if (changed("volumes"))     patchVolumes(doc, at("volumes"), old.volumes, next.volumes, KEEP);

  if (changed("networks")) {
    patchListField(doc, at("networks"), old.networks, next.networks, {
      seq: stringSeqCodec(doc), map: keyOnlyMapCodec(doc, () => null), fresh: e => [...e],
    }, KEEP);
  }
  if (changed("dependsOn")) {
    // A new entry in long-form depends_on needs a condition; service_started is compose's default
    patchListField(doc, at("depends_on"), old.dependsOn, next.dependsOn, {
      seq: stringSeqCodec(doc), map: keyOnlyMapCodec(doc, () => ({ condition: "service_started" })), fresh: e => [...e],
    }, KEEP);
  }
  const strList = (key: string, from: string[], values: string[]) => patchListField(doc, at(key), from, values, {
    seq: stringSeqCodec(doc), scalar: v => v, fresh: e => [...e],
  }, KEEP);
  if (changed("capAdd"))  strList("cap_add",  old.capAdd,  next.capAdd);
  if (changed("capDrop")) strList("cap_drop", old.capDrop, next.capDrop);
  if (changed("devices")) strList("devices",  old.devices, next.devices);
  if (changed("dns"))     strList("dns",      old.dns,     next.dns);
  if (changed("extraHosts")) {
    // In map form a host is a key, so it can appear only once (the last row wins)
    const hosts = (rows: string[]) => isMapAt(doc, at("extra_hosts")) ? dedupeBy(rows, h => splitHostEntry(h).host) : rows;
    patchListField(doc, at("extra_hosts"), hosts(old.extraHosts), hosts(next.extraHosts), {
      seq: stringSeqCodec(doc),
      map: {
        read:   item => formatHostEntry(pairKey(doc, item as AnyPair), js(doc, (item as AnyPair).value)),
        update: (item, _cur, nx) => {
          const pair = item as AnyPair;
          const { host, ip } = splitHostEntry(nx);
          renamePair(doc, pair, host);
          pair.value = ip === null ? doc.createNode(null) : updateScalarNode(doc, pair.value, ip);
          return pair;
        },
        create: nx => { const { host, ip } = splitHostEntry(nx); return doc.createPair(host, ip); },
      },
      fresh: e => [...e],
    }, KEEP);
  }

  if (changed("logging")) {
    if (next.logging.driver !== base.logging.driver) {
      if (next.logging.driver) setScalar(doc, at("logging", "driver"), next.logging.driver);
      else deletePath(doc, at("logging", "driver"), KEEP);
    }
    if (!same(next.logging.options, base.logging.options)) {
      const opts = dedupeBy(next.logging.options, byKey);
      patchListField(doc, at("logging", "options"), dedupeBy(old.logging.options, byKey), opts, {
        map:   keyValueMapCodec(doc, raw => String(raw ?? "")),
        fresh: e => Object.fromEntries(e.map(o => [o.key, o.value])),
      }, KEEP);
    }
  }

  if (changed("memLimitMb")) patchLimit(doc, svc, "mem_limit", "memory", next.memLimitMb > 0 ? `${next.memLimitMb}m` : null);
  if (changed("cpuLimit"))   patchLimit(doc, svc, "cpus",      "cpus",   next.cpuLimit   > 0 ? String(next.cpuLimit) : null);

  if (changed("command"))    patchArgs(doc, at("command"),    next.command, KEEP);
  if (changed("entrypoint")) patchArgs(doc, at("entrypoint"), next.entrypoint, KEEP);

  if (changed("healthcheckTest"))     patchHealthcheckTest(doc, at("healthcheck", "test"), next.healthcheckTest, KEEP);
  if (changed("healthcheckInterval")) hcStr("interval", next.healthcheckInterval);
  if (changed("healthcheckTimeout"))  hcStr("timeout",  next.healthcheckTimeout);
  if (changed("healthcheckRetries")) {
    if (next.healthcheckRetries > 0) setScalar(doc, at("healthcheck", "retries"), next.healthcheckRetries);
    else deletePath(doc, at("healthcheck", "retries"), KEEP);
  }

  function hcStr(key: string, value: string): void {
    if (value) setScalar(doc, at("healthcheck", key), value);
    else deletePath(doc, at("healthcheck", key), KEEP);
  }
}

// ─── Field patchers ───────────────────────────────────────────────────────────

type PortEntry   = ServiceForm["ports"][number];
type VolumeEntry = ServiceForm["volumes"][number];
type EnvEntry    = ServiceForm["environment"][number];
type LabelEntry  = ServiceForm["labels"][number];

function patchPorts(doc: Doc, path: Path, base: readonly PortEntry[], next: readonly PortEntry[], keep: number): void {
  patchListField(doc, path, base, next, {
    seq: {
      read:   item => parsePortEntry(js(doc, item)),
      update: (item, cur, nx) => {
        // The form shows any protocol but udp as tcp, so one it did not edit
        // (`${PROTO:-udp}`, `sctp`) is kept as written
        const protoEdited = cur.protocol !== nx.protocol;
        if (!isMap(item)) {
          const original = String(js(doc, item) ?? "");
          const slash    = lastIndexOfOutsideVars(original, "/");
          const port     = !protoEdited && slash >= 0
            ? `${formatPort({ ...nx, protocol: "tcp" })}${original.slice(slash)}`
            : formatPort(nx);
          return updateScalarNode(doc, item, port);
        }
        // Long syntax: edit its keys, keep the rest (host_ip, mode, name...)
        const put = (k: string, v: Prim) => putScalar(doc, item, k, v);
        if (nx.host) put("published", nx.host); else item.delete("published");
        put("target", nx.container);
        if (protoEdited) {
          if (nx.protocol === "udp") put("protocol", "udp");
          else if (item.has("protocol")) put("protocol", "tcp");
        }
        return item;
      },
      create: (nx, template) => styledNode(doc, formatPort(nx), template),
    },
    fresh: e => e.map(formatPort),
  }, keep);
}

/**
 * Short-syntax mount options with the access mode set to `mode`: only the
 * `ro`/`rw` token changes, so `ro,z` becomes `rw,z` and keeps its SELinux label.
 */
function withAccessMode(options: string, mode: VolumeEntry["mode"]): string {
  const rest = options.split(",").filter(o => o !== "" && o !== "ro" && o !== "rw");
  return (mode ? [mode, ...rest] : rest).join(",");
}

function patchVolumes(doc: Doc, path: Path, base: readonly VolumeEntry[], next: readonly VolumeEntry[], keep: number): void {
  patchListField(doc, path, base, next, {
    seq: {
      read:   item => parseVolumeEntry(js(doc, item)),
      update: (item, cur, nx) => {
        if (isMap(item)) {
          const put = (k: string, v: Prim) => putScalar(doc, item, k, v);
          if (nx.host) put("source", nx.host); else item.delete("source");
          put("target", nx.container);
          if (cur.mode !== nx.mode) {
            if (nx.mode === "ro") put("read_only", true); else item.delete("read_only");
          }
          return item;
        }
        // Short syntax: keep the options the form cannot show (`z`, `nocopy`); a mode edit swaps only the ro/rw token
        const original = String(js(doc, item) ?? "");
        const options  = splitOutsideVars(original, ":").slice(2).join(":");
        const value    = volumeItem(nx, cur.mode === nx.mode ? options : withAccessMode(options, nx.mode));
        return typeof value === "string" ? updateScalarNode(doc, item, value) : doc.createNode(value);
      },
      create: (nx, template) => styledNode(doc, volumeItem(nx), template),
    },
    fresh: e => e.map(v => volumeItem(v)),
  }, keep);
}

function patchEnvironment(doc: Doc, path: Path, base: readonly EnvEntry[], next: readonly EnvEntry[], keep: number): void {
  const rows = (r: readonly EnvEntry[]) => isMapAt(doc, path) ? dedupeBy(r, byKey) : r;
  patchListField(doc, path, rows(base), rows(next), {
    seq: {
      read:   item => parseKeyValueItem(js(doc, item)),
      update: (item, _cur, nx) => updateScalarNode(doc, item, formatEnv(nx)),
      create: (nx, template) => styledNode(doc, formatEnv(nx), template),
    },
    map:   keyValueMapCodec<string | null>(doc, raw => raw == null ? null : String(raw)),
    fresh: e => e.map(formatEnv),
  }, keep);
}

function patchLabels(doc: Doc, path: Path, base: readonly LabelEntry[], next: readonly LabelEntry[], keep: number): void {
  const rows = (r: readonly LabelEntry[]) => isMapAt(doc, path) ? dedupeBy(r, byKey) : r;
  patchListField(doc, path, rows(base), rows(next), {
    seq: {
      read:   item => { const e = parseKeyValueItem(js(doc, item)); return { key: e.key, value: e.value ?? "" }; },
      update: (item, _cur, nx) => updateScalarNode(doc, item, formatLabel(nx)),
      create: (nx, template) => styledNode(doc, formatLabel(nx), template),
    },
    map:   keyValueMapCodec<string>(doc, raw => raw == null ? "" : String(raw)),
    fresh: e => e.map(formatLabel),
  }, keep);
}

/**
 * Resource limits live either at the service level (`mem_limit`, `cpus`) or
 * under `deploy.resources.limits`. Update every place the file uses so the
 * two cannot disagree; with neither present, use the deploy form.
 */
function patchLimit(doc: Doc, svc: Path, flatKey: string, deployKey: string, value: string | null): void {
  const flat   = [...svc, flatKey];
  const deploy = [...svc, "deploy", "resources", "limits", deployKey];
  const where  = [flat, deploy].filter(p => doc.hasIn(p));
  if (value === null) { for (const p of where) deletePath(doc, p, svc.length); return; }
  for (const p of where.length > 0 ? where : [deploy]) setScalar(doc, p, value);
}

/**
 * `command` / `entrypoint`. An array stays an array; unchanged elements keep
 * their nodes. A string stays a string. A new value is written as a string.
 *
 * @throws When an array is edited to a string with unbalanced quotes; compose
 *         tokenizes a string command the same way and would reject it
 */
function patchArgs(doc: Doc, path: Path, value: string, keep: number): void {
  if (!value.trim()) { deletePath(doc, path, keep); return; }
  const node = doc.getIn(path, true);
  if (!isSeq(node)) { setScalar(doc, path, value); return; }
  const tokens = splitArgs(value);
  if (!tokens || tokens.length === 0) throw new Error(`${String(path[path.length - 1])}: unbalanced quotes in ${JSON.stringify(value)}`);
  patchItems(node, tokens, stringSeqCodec(doc));
}

/**
 * `healthcheck.test`. A `CMD` array stays `CMD` when the edit splits cleanly,
 * otherwise it becomes `CMD-SHELL` (the shell then does the splitting). A
 * `CMD-SHELL` array or plain string keeps its form. A new test is CMD-SHELL.
 */
function patchHealthcheckTest(doc: Doc, path: Path, value: string, keep: number): void {
  if (!value.trim()) { deletePath(doc, path, keep); return; }
  const node = doc.getIn(path, true);
  if (isScalar(node)) { node.value = value; return; }
  const shell = ["CMD-SHELL", value];
  if (!isSeq(node)) { setValue(doc, path, shell); return; }
  const kind   = String(js(doc, node.items[0]) ?? "");
  const tokens = kind === "CMD" ? splitArgs(value) : null;
  patchItems(node, tokens && tokens.length > 0 ? ["CMD", ...tokens] : shell, stringSeqCodec(doc));
}

// ═══ Printing with the original bytes kept ═══════════════════════════════════

/**
 * Guess the printer options that reproduce the file's own layout (indent
 * width, whether `- ` items are indented under their key, padding inside
 * flow brackets), so fewer lines differ from the original.
 */
function detectPrintOptions(src: string): ToStringOptions {
  const lines = src.split("\n");
  let indent = 2;
  const firstIndented = lines.find(l => /^ +[^\s#-]/.test(l));
  if (firstIndented) indent = Math.min(8, firstIndented.length - firstIndented.trimStart().length) || 2;

  let indentSeq = true;
  for (let i = 1; i < lines.length; i++) {
    const item = /^( *)- /.exec(lines[i]!);
    if (!item) continue;
    let j = i - 1;
    while (j >= 0 && /^\s*(#.*)?$/.test(lines[j]!)) j--;
    const key = j >= 0 ? /^( *)[^\s-][^#]*:\s*(#.*)?$/.exec(lines[j]!) : null;
    if (key) { indentSeq = item[1]!.length > key[1]!.length; break; }
  }

  const flow = /[[{]( ?)[^\]}\n]*[\]}]/.exec(src);
  const flowCollectionPadding = flow ? flow[1] === " " : true;

  return { indent, indentSeq, flowCollectionPadding, lineWidth: 0, nullStr: "" };
}

/**
 * Print `doc`, but keep every line of `original` that the edit did not touch.
 *
 * `S0` is the original document printed, `S1` the edited one printed. The
 * changes S0 → S1 are found with a line diff, located in the original text
 * through an S0 ↔ original line alignment, and spliced in there. The result
 * is accepted only if it parses to exactly the edited data; otherwise the
 * plain print `S1` is returned, which is always correct.
 */
function printPreservingSource(source: string, doc: Doc): string {
  // The printer writes LF. Work in LF and restore CRLF at the end, or no
  // original line (each ending in \r) would match a printed one.
  const crlf = source.includes("\r\n");
  const out  = printPreservingLF(crlf ? source.replace(/\r\n/g, "\n") : source, doc);
  return crlf ? out.replace(/\n/g, "\r\n") : out;
}

function printPreservingLF(original: string, doc: Doc): string {
  const opts = detectPrintOptions(original);
  const s1   = doc.toString(opts);
  const s0   = parseDocument(original).toString(opts);
  if (s0 === original) return s1;

  const spliced = spliceChanges(original.split("\n"), s0.split("\n"), s1.split("\n"));
  if (spliced === null) return s1;
  try {
    if (JSON.stringify(parse(spliced)) === JSON.stringify(doc.toJS())) return spliced;
  } catch { /* fall through to the plain print */ }
  return s1;
}

/** Apply the line changes between `s0` and `s1` to `o`, which `s0` is a reprint of. */
function spliceChanges(o: string[], s0: string[], s1: string[]): string | null {
  const edits = lcsPairs(s0, s1);
  const align = lcsPairs(s0, o);
  if (!edits || !align) return null;

  // s0 line → original line, or -1 when the reprint changed that line
  const toO = new Array<number>(s0.length).fill(-1);
  for (const [a, b] of align) toO[a] = b;

  // Hunks of s0 → s1: [a0, a1) in s0 replaced by [b0, b1) in s1
  const hunks: Array<{ a0: number; a1: number; b0: number; b1: number }> = [];
  let pa = 0, pb = 0;
  for (const [a, b] of [...edits, [s0.length, s1.length] as [number, number]]) {
    if (a > pa || b > pb) hunks.push({ a0: pa, a1: a, b0: pb, b1: b });
    pa = a + 1; pb = b + 1;
  }

  // Widen each hunk to the nearest s0 lines that exist verbatim in the
  // original (anchors), then merge hunks whose widened ranges touch.
  type Hunk   = (typeof hunks)[number];
  type Region = { r0: number; r1: number; t0: number; t1: number; hunks: Hunk[] };
  const regions: Region[] = [];
  for (const h of hunks) {
    let r0 = h.a0;
    while (r0 > 0 && toO[r0 - 1] === -1) r0--;
    let r1 = h.a1;
    while (r1 < s0.length && toO[r1] === -1) r1++;
    const region = { r0, r1, t0: h.b0 - (h.a0 - r0), t1: h.b1 + (r1 - h.a1), hunks: [h] };
    const last = regions[regions.length - 1];
    if (last && region.r0 <= last.r1) { last.r1 = region.r1; last.t1 = region.t1; last.hunks.push(h); }
    else regions.push(region);
  }

  const out = [...o];
  for (let k = regions.length - 1; k >= 0; k--) {
    const { r0, r1, t0, t1, hunks: inRegion } = regions[k]!;
    const o0 = r0 === 0 ? 0 : toO[r0 - 1]! + 1;
    const o1 = r1 === s0.length ? o.length : toO[r1]!;
    if (o0 > o1 || t0 < 0 || t1 > s1.length) return null;
    if (o1 - o0 === r1 - r0) {
      // Same number of lines between the anchors: the reprint only restyled
      // lines (comment spacing, say), so they correspond one to one. Replace
      // just the changed lines and keep the neighbours as written.
      for (let j = inRegion.length - 1; j >= 0; j--) {
        const h = inRegion[j]!;
        out.splice(o0 + (h.a0 - r0), h.a1 - h.a0, ...s1.slice(h.b0, h.b1));
      }
    } else {
      out.splice(o0, o1 - o0, ...s1.slice(t0, t1));
    }
  }
  return out.join("\n");
}
