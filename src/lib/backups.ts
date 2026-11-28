/**
 * Backups: the system (config, database) and each app (its stack folder and its data), to a
 * folder on this machine, and back.
 *
 * One backup is one folder in `[backups] folder`, named by when it was taken:
 *
 *   20261128-093000/
 *     manifest.json              what is in it, and where each part goes back to
 *     system.tar.gz              config.toml, a snapshot of storage.db, samba.conf, certs/
 *     apps/<name>/stack.tar.gz   the app's stack folder (compose file, .env, anything beside)
 *     apps/<name>/data-0.tar.gz  one per data folder of the app under `[apps] data_root`
 *
 * A folder, rather than one archive, so each app is archived on its own (and stopped only
 * for its own copy), and a backup can be downloaded as a single tar streamed from it, with
 * no second copy on disk.
 *
 * Archives are made and read by the system `tar`, which streams (app data can be gigabytes),
 * keeps owners and permissions, and is on every Linux and macOS machine.
 *
 * What an app's data is: the host folders its services bind-mount from under the data root,
 * one folder per first path segment (`/DATA/AppData/jellyfin/config` is `jellyfin`). Binds
 * elsewhere (a media library, `/var/run/docker.sock`) are not the app's to back up, and named
 * Docker volumes are not folders anpan-os manages; both are named in the job's log.
 */
import { chmod, lstat, mkdir, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { Database } from "bun:sqlite";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { config } from "../config";
import { envConfig } from "../env-config";
import { snapshotDatabase } from "../db";
import { StackStore } from "../stores/stack-store";
import { DockerClient } from "./docker";
import type { NewStack } from "../db/schema";
import { bins } from "./commands";
import { composeCommand, COMPOSE_FILE } from "./compose-cmd";
import { JobError, processRunner, type JobContext } from "./jobs";
import { PENDING_DIR, PREVIOUS_SUFFIX, READY_MARKER, SYSTEM_ENTRIES } from "./pending-restore";
import { reservePaths } from "./path-reservations";
import { MigrationManager } from "../db/migration-manager";
import { CASAOS_APPS_DIR } from "./platform";
import { stackDir } from "./stack-ops";
import { STACK_NAME_RE } from "../constants/stack";

/** A backup's folder name: when it was taken, UTC, with a suffix when two share a second. */
export const BACKUP_ID_RE = /^\d{8}-\d{6}(?:-\d{1,3})?$/;

/** The manifest format this code writes and reads. */
const FORMAT = 1;

const MANIFEST = "manifest.json";
const SYSTEM_ARCHIVE = "system.tar.gz";

/** One app in a backup. */
export interface BackupApp {
  name:       string;
  /** Whose folder the stack lived in: anpan-os's compose folder, or CasaOS's apps folder. */
  origin:     "anpan" | "casaos";
  /** Copied while running rather than stopped for the copy. */
  live:       boolean;
  /** The services running when backed up; a restore starts these again, and only these. */
  running:    string[];
  /** The stack folder's archive, relative to the backup folder. */
  stack:      string;
  /**
   * Data folders: `dir` is the folder's path under the data root, usually the app's own
   * folder there (`jellyfin`), or a folder deeper down when the app shares its first-level
   * folder with another app (`shared/jellyfin`).
   */
  data:       { dir: string; archive: string }[];
  /** The app's row (tile settings), without id and timestamp; null when it had none. */
  row:        Record<string, unknown> | null;
}

/** What a backup holds; `manifest.json`. */
export interface BackupManifest {
  format:    number;
  id:        string;
  createdAt: string;
  version:   string;
  hostname:  string;
  /** `[apps] data_root` when it was taken; app data goes back under the same root. */
  dataRoot:  string;
  /** The system archive, or null when the backup has none. */
  system:    string | null;
  apps:      BackupApp[];
}

/** A backup as listed. */
export interface BackupSummary {
  id:        string;
  createdAt: string;
  version:   string;
  hostname:  string;
  dataRoot:  string;
  system:    boolean;
  apps:      { name: string; live: boolean; wasRunning: boolean; dataDirs: string[] }[];
  /** Bytes on disk, all parts together. */
  size:      number;
}

// ─── Paths ──────────────────────────────────────────────────────────────────

function folder(): string {
  return config.backupsFolder;
}

/** A backup's folder. `id` must already have passed {@link BACKUP_ID_RE}. */
export function backupPath(id: string): string {
  return join(folder(), id);
}

function runtimeDir(): string {
  return resolve(envConfig.RUNTIME_CONFIG_DIR);
}

function tar(): string {
  const path = Bun.which("tar");
  if (!path) throw new JobError("tar is not installed on this system");
  return path;
}

let gnuTar: boolean | null = null;

/**
 * Whether the system tar is GNU tar. Its exit code 1 means "some files changed while being
 * read", a warning; bsdtar (macOS) uses 1 for real failures, such as an archive it could
 * not finish writing.
 */
function isGnuTar(): boolean {
  gnuTar ??= Bun.spawnSync([tar(), "--version"]).stdout.toString().includes("GNU tar");
  return gnuTar;
}

function docker(): string {
  if (!bins.docker) throw new JobError("Docker is not available on this system");
  return bins.docker;
}

/**
 * Whether `path` exists. Only "no such file" means no: a permission or I/O error is thrown,
 * so that a restore never takes a folder it could not look at for one that is not there
 * (and replaces it without a safety copy).
 */
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

/**
 * Remove `path` as cleanup: a failure is logged, never thrown, so it cannot replace the
 * error that led here, and the path is named for the user to remove.
 */
async function tidy(ctx: JobContext, path: string): Promise<void> {
  await rm(path, { recursive: true, force: true }).catch(e => ctx.log(`⚠ Could not remove ${path}: ${(e as Error).message}`));
}

/** The folder name for a backup taken at `date`: `YYYYMMDD-HHMMSS`, UTC. */
export function backupIdFor(date: Date): string {
  const iso = date.toISOString(); // 2026-11-28T09:30:00.000Z
  return `${iso.slice(0, 10).replaceAll("-", "")}-${iso.slice(11, 19).replaceAll(":", "")}`;
}

/**
 * Order backup ids oldest first: by time, then by suffix as a number, an id without one
 * being the first of its second (so `-10` comes after `-9`, not before `-2`).
 */
function compareIds(a: string, b: string): number {
  const split = (id: string): [string, number] => {
    const m = /^(\d{8}-\d{6})(?:-(\d+))?$/.exec(id);
    return m ? [m[1]!, m[2] ? Number(m[2]) : 1] : [id, 0];
  };
  const [ta, na] = split(a);
  const [tb, nb] = split(b);
  return ta === tb ? na - nb : ta.localeCompare(tb);
}

/** `base`, or `base-2`, `base-3`… whichever is free in the backups folder. */
async function freeId(id: string): Promise<string> {
  const base = id.replace(/-\d{1,3}$/, "");
  for (let n = 1; n < 1000; n++) {
    const id = n === 1 ? base : `${base}-${n}`;
    if (!(await exists(backupPath(id)))) return id;
  }
  throw new JobError("Too many backups with the same time");
}

// ─── Manifest ───────────────────────────────────────────────────────────────

/** One path segment of a data folder: not empty, not `.` or `..`, no backslash or NUL. */
const SEGMENT_RE = /^[^/\\\0]+$/;
/**
 * A Compose service name (the spec's `[a-zA-Z0-9._-]+`), except one starting with `-`,
 * which a command line would read as an option. Such a service is not recorded as running.
 */
const SERVICE_RE = /^[A-Za-z0-9._][A-Za-z0-9._-]*$/;
const DATA_ARCHIVE_RE = /^data-\d{1,4}\.tar\.gz$/;

/** The stack archive's name for app `name`; nothing else is accepted in its place. */
const stackArchive = (name: string) => `apps/${name}/stack.tar.gz`;
/** Whether `archive` is one of app `name`'s data archives. Compared as strings, not a pattern built from the name. */
const isDataArchive = (name: string, archive: string) => {
  const prefix = `apps/${name}/`;
  return archive.startsWith(prefix) && DATA_ARCHIVE_RE.test(archive.slice(prefix.length));
};

/** Whether `dir` is a relative path of plain segments: `jellyfin` or `shared/jellyfin`. */
function isDataDir(dir: string): boolean {
  const parts = dir.split("/");
  return parts.length <= 16 && parts.every(p => SEGMENT_RE.test(p) && p !== "." && p !== "..");
}

/** Whether `a` is `b` or inside it, as `/`-separated relative paths. */
function nestedIn(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`);
}

/**
 * Read a manifest, checking every field. Null when it is not one this code wrote.
 *
 * A backup can be uploaded, so its manifest is checked as input: the archive names and
 * data folders in it decide which files a restore reads and writes. Each is held to the
 * shape this code gives it, so none can name a path outside the backup or the data root.
 */
export function parseManifest(text: string): BackupManifest | null {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return null; }
  if (typeof raw !== "object" || raw === null) return null;
  const m = raw as Record<string, unknown>;
  const str = (v: unknown): v is string => typeof v === "string";
  if (m.format !== FORMAT || !str(m.id) || !BACKUP_ID_RE.test(m.id)) return null;
  if (!str(m.createdAt) || !str(m.version) || !str(m.hostname) || !str(m.dataRoot)) return null;
  if (m.system !== null && m.system !== SYSTEM_ARCHIVE) return null;
  if (!Array.isArray(m.apps)) return null;

  const apps: BackupApp[] = [];
  const names = new Set<string>();
  for (const a of m.apps as unknown[]) {
    if (typeof a !== "object" || a === null) return null;
    const app = a as Record<string, unknown>;
    if (!str(app.name) || !STACK_NAME_RE.test(app.name) || names.has(app.name)) return null;
    names.add(app.name);
    if (app.origin !== "anpan" && app.origin !== "casaos") return null;
    if (typeof app.live !== "boolean") return null;
    if (!Array.isArray(app.running) || !app.running.every(r => str(r) && SERVICE_RE.test(r))) return null;
    if (app.stack !== stackArchive(app.name)) return null;
    if (!Array.isArray(app.data)) return null;
    const data: BackupApp["data"] = [];
    for (const d of app.data as unknown[]) {
      const entry = d as Record<string, unknown> | null;
      if (!entry || !str(entry.dir) || !str(entry.archive)) return null;
      if (!isDataDir(entry.dir) || !isDataArchive(app.name, entry.archive)) return null;
      // No folder in or at another: two archives unpacked into one tree could have the
      // first plant a link that the second then writes through.
      if (data.some(o => nestedIn(o.dir, entry.dir as string) || nestedIn(entry.dir as string, o.dir))) return null;
      data.push({ dir: entry.dir, archive: entry.archive });
    }
    const row = app.row === null || (typeof app.row === "object" && !Array.isArray(app.row))
      ? app.row as Record<string, unknown> | null
      : undefined;
    if (row === undefined) return null;
    apps.push({ name: app.name, origin: app.origin, live: app.live, running: app.running as string[], stack: app.stack, data, row });
  }
  return {
    format: FORMAT, id: m.id, createdAt: m.createdAt, version: m.version, hostname: m.hostname,
    dataRoot: m.dataRoot, system: m.system as string | null, apps,
  };
}

/** The manifest in a backup folder, or null when it is missing or not valid. */
async function readManifest(dir: string): Promise<BackupManifest | null> {
  const file = Bun.file(join(dir, MANIFEST));
  if (!(await file.exists())) return null;
  return parseManifest(await file.text());
}

/** The tile settings a backup's row may put back, each only when it has the column's type. */
function rowFrom(raw: Record<string, unknown> | null): Partial<Omit<NewStack, "id">> | null {
  if (!raw) return null;
  const out: Record<string, unknown> = {};
  const text = ["title", "icon", "tagline", "portMap", "scheme", "indexPath", "mainService", "address", "note", "openMode"];
  for (const key of text) {
    const v = raw[key];
    if (v === null || typeof v === "string") out[key] = v;
  }
  for (const key of ["managed", "backupLive"]) if (typeof raw[key] === "boolean") out[key] = raw[key];
  if (raw.orderNo === null || Number.isInteger(raw.orderNo)) out.orderNo = raw.orderNo;
  return out as Partial<Omit<NewStack, "id">>;
}

// ─── Listing ────────────────────────────────────────────────────────────────

/** Every backup in the folder, newest first. Folders without a valid manifest are skipped. */
export async function listBackups(): Promise<BackupSummary[]> {
  const names = await readdir(folder()).catch(() => [] as string[]);
  const out: BackupSummary[] = [];
  for (const id of names) {
    if (!BACKUP_ID_RE.test(id)) continue;
    const dir = backupPath(id);
    const m = await readManifest(dir);
    if (!m) continue;
    const parts = [MANIFEST, ...(m.system ? [m.system] : []), ...m.apps.flatMap(a => [a.stack, ...a.data.map(d => d.archive)])];
    const sizes = await Promise.all(parts.map(p => stat(join(dir, p)).then(s => s.size, () => 0)));
    out.push({
      id, createdAt: m.createdAt, version: m.version, hostname: m.hostname, dataRoot: m.dataRoot,
      system: m.system !== null,
      apps: m.apps.map(a => ({ name: a.name, live: a.live, wasRunning: a.running.length > 0, dataDirs: a.data.map(d => d.dir) })),
      size: sizes.reduce((sum, n) => sum + n, 0),
    });
  }
  return out.sort((a, b) => compareIds(b.id, a.id));
}

/** The manifest of backup `id`, or null when there is no such backup. */
export async function getBackup(id: string): Promise<BackupManifest | null> {
  if (!BACKUP_ID_RE.test(id)) return null;
  return readManifest(backupPath(id));
}

/** Delete backup `id`. False when there is no such backup. */
export async function deleteBackup(id: string): Promise<boolean> {
  if (!(await getBackup(id))) return false;
  await rm(backupPath(id), { recursive: true, force: true });
  return true;
}

// ─── Taking a backup ────────────────────────────────────────────────────────

/** What a backup should contain. */
export interface BackupRequest {
  system: boolean;
  apps:   string[];
}

/** Where `name`'s stack folder is, and whose it is; null when it has no compose file. */
export async function appFolder(name: string): Promise<{ dir: string; origin: BackupApp["origin"] } | null> {
  const dir = folderFor(name, "anpan");
  if (await Bun.file(join(dir, COMPOSE_FILE)).exists()) return { dir, origin: "anpan" };
  const casaos = folderFor(name, "casaos");
  if (await Bun.file(join(casaos, COMPOSE_FILE)).exists()) return { dir: casaos, origin: "casaos" };
  return null;
}

/**
 * The stack folder of `name` in anpan-os's compose folder or CasaOS's apps folder. Absolute:
 * tar runs inside the folders it reads, so a relative one would be read from the wrong place.
 */
function folderFor(name: string, origin: BackupApp["origin"]): string {
  return resolve(origin === "casaos" ? join(CASAOS_APPS_DIR, name) : stackDir(name));
}

/** Whether `child` is `parent` or inside it. Both absolute and resolved. */
function within(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

/**
 * Bind mounts of every container but `stack`'s, by source with links followed, from
 * Docker: what other apps use, so one app's backup and restore leave it alone.
 *
 * Throws when Docker cannot say: an empty answer would make every folder look like this
 * app's alone, and a restore could then replace another app's data.
 */
async function otherAppsBinds(stack: string): Promise<string[]> {
  const containers = await DockerClient.listContainers();
  if (!containers.ok) throw new JobError(`Could not read from Docker which folders other apps use: ${containers.error}`);
  const out: string[] = [];
  const foreign = containers.data.filter(c => (c.Labels?.["com.docker.compose.project"] ?? "") !== stack);
  for (const r of await Promise.all(foreign.map(c => DockerClient.inspectContainer(c.Id)))) {
    if (!r.ok) throw new JobError(`Could not read from Docker which folders other apps use: ${r.error}`);
    for (const m of r.data.Mounts) if (m.Type === "bind") out.push(await realExisting(m.Source));
  }
  return out;
}

/**
 * Refuse when another app mounts `dir` or anything in or around it. Compared with links
 * followed on both sides: a path through a link names the same files as its target.
 */
async function refuseShared(dir: string, others: string[], what: string): Promise<void> {
  const real = await realExisting(dir);
  const used = others.find(o => overlaps(o, real));
  if (used) throw new JobError(`Another app uses ${used}, in or around ${dir}; ${what}`);
}

/** Whether `a` and `b` are one folder, or one is inside the other. */
function overlaps(a: string, b: string): boolean {
  return within(a, b) || within(b, a);
}

/**
 * The data folders of a stack, read from Compose's resolved configuration.
 *
 * Usually the app's first-level folder under the data root, holding every bind source of
 * the app there (`jellyfin` for `jellyfin/config` and `jellyfin/cache`). When another app
 * mounts something inside that folder too, it is not this app's alone: then only this
 * app's own bind sources there are taken, so that restoring this app never replaces the
 * other's data, and a cold copy does not take files the other is still writing.
 *
 * Everything else the stack mounts is logged as not included.
 */
async function dataFolders(ctx: JobContext, name: string, dir: string, others: string[]): Promise<string[]> {
  const out = await processRunner.capture([...composeCommand(docker(), name, dir), "config", "--format", "json"], { cwd: dir, signal: ctx.signal });
  ctx.throwIfCancelled();
  if (out.code !== 0) {
    const detail = out.stderr.trim().split("\n").slice(-2).join(" ");
    throw new JobError(`Docker Compose rejected ${name}'s file: ${detail || `exit code ${out.code}`}`);
  }
  let resolved: { services?: Record<string, { volumes?: { type?: string; source?: string }[] }> };
  try { resolved = JSON.parse(out.stdout); } catch { throw new JobError(`Could not read ${name}'s compose configuration`); }

  const root = config.appDataRoot;
  const sources: string[] = [];
  const skipped = new Set<string>();
  for (const service of Object.values(resolved.services ?? {})) {
    for (const v of service.volumes ?? []) {
      if (!v.source) continue;
      if (v.type === "volume") { skipped.add(`named volume "${v.source}"`); continue; }
      if (v.type !== "bind") continue;
      const source = resolve(v.source);
      if (within(source, dir)) continue; // in the stack folder's own archive
      if (source !== root && within(source, root)) sources.push(source);
      else skipped.add(`${source} (outside ${root})`);
    }
  }

  const candidates = new Set<string>();
  for (const source of sources) {
    const first = join(root, relative(root, source).split(sep)[0]!);
    // Another app's mount in the folder, or around it (one that mounts the whole data root,
    // say): either way the folder is not this app's alone. Links followed, as Docker does.
    const realFirst = await realExisting(first);
    const shared = others.some(o => overlaps(o, realFirst));
    if (!shared) { candidates.add(first); continue; }
    // Shared with another app: this app's own folder only, and only when no other app
    // uses it or anything in it. A single file cannot be replaced on its own by a
    // restore, so it is left out.
    const realSource = await realExisting(source);
    if (others.some(o => overlaps(o, realSource))) skipped.add(`${source} (another app uses it too)`);
    else if ((await stat(source).catch(() => null))?.isDirectory()) candidates.add(source);
    else skipped.add(`${source} (a single file in ${first}, which other apps use too)`);
  }

  // Only folders that are there (a bind to a path Docker has not created yet holds
  // nothing), outermost only, and under the data root once links are followed: tar would
  // read through a link to another drive, and a restore would put a real folder in its place.
  const realRoot = await realpath(root).catch(() => root);
  const present: string[] = [];
  for (const f of [...candidates].sort()) {
    if (present.some(p => within(f, p))) continue;
    if (!(await stat(f).catch(() => null))?.isDirectory()) continue;
    const real = await realpath(f).catch(() => f);
    if (!within(real, realRoot)) { skipped.add(`${f} (a link to ${real}, outside ${root})`); continue; }
    // A path the manifest can hold, so that the backup it goes in can be read back.
    if (!isDataDir(relative(root, f).split(sep).join("/"))) { skipped.add(`${f} (too deep under ${root})`); continue; }
    present.push(f);
  }
  for (const what of [...skipped].sort()) ctx.log(`  Not included: ${what}`);
  return present;
}

/** The services of `name` that are running now. */
async function runningServices(ctx: JobContext, name: string, dir: string): Promise<string[]> {
  const out = await processRunner.capture([...composeCommand(docker(), name, dir), "ps", "--status", "running", "--services"], { cwd: dir, signal: ctx.signal });
  ctx.throwIfCancelled();
  if (out.code !== 0) throw new JobError(`Could not read ${name}'s state (docker compose ps: exit code ${out.code})`);
  return out.stdout.split("\n").map(s => s.trim()).filter(s => SERVICE_RE.test(s));
}

/**
 * Archive the contents of `dir` into `out`. When `live`, a file that changed while it was
 * read is a warning (GNU tar's exit code 1, and only GNU tar's), not a failure: that is what
 * copying a running app means, and the user chose it.
 *
 * The backups folder is left out when it lies inside `dir`: the copy would otherwise take
 * every earlier backup, and the one being written.
 */
async function archive(ctx: JobContext, dir: string, out: string, live: boolean): Promise<void> {
  ctx.throwIfCancelled();
  const argv = [tar(), "-czf", out, "--numeric-owner"];
  if (within(folder(), dir) && folder() !== dir) argv.push(`--exclude=./${relative(dir, folder())}`);
  argv.push("-C", dir, ".");
  const code = await processRunner.run(argv, { cwd: dir, signal: ctx.signal, onLine: line => ctx.log(line) });
  ctx.throwIfCancelled();
  if (code === 1 && live && isGnuTar()) { ctx.log(`  Some files in ${dir} changed while they were copied`); return; }
  if (code !== 0) throw new JobError(`Could not archive ${dir} (tar: exit code ${code})`);
}

/**
 * Back up one app into `<partial>/apps/<name>/`. `restartFailed` is set when the app was
 * stopped for the copy and could not be started again: the copy is good, but the job must
 * say the app is down.
 */
async function backUpApp(ctx: JobContext, name: string, partial: string): Promise<{ entry: BackupApp; restartFailed: boolean }> {
  const found = await appFolder(name);
  if (!found) throw new JobError(`${name} has no compose file`);
  const { dir, origin } = found;
  const row = await StackStore.findById(name);
  const live = row?.backupLive ?? false;

  const others = await otherAppsBinds(name);
  await refuseShared(dir, others, `not backing up ${name}, whose stack folder that is`);
  const data = await dataFolders(ctx, name, dir, others);
  const running = await runningServices(ctx, name, dir);
  await mkdir(join(partial, "apps", name), { recursive: true });

  const stop = !live && running.length > 0;
  const entry: BackupApp = { name, origin, live, running, stack: stackArchive(name), data: [], row: null };
  let restartFailed = false;
  try {
    // Inside the try: a stop that fails or is cancelled half way may already have stopped
    // some services, and the finally starts them again.
    if (stop) {
      ctx.log(`  Stopping ${name} while its files are copied`);
      await ctx.exec([...composeCommand(docker(), name, dir), "stop"], dir, "docker compose stop");
    }
    await archive(ctx, dir, join(partial, entry.stack), live);
    for (const [i, folder] of data.entries()) {
      const archiveName = `apps/${name}/data-${i}.tar.gz`;
      ctx.log(`  Data: ${folder}`);
      await archive(ctx, folder, join(partial, archiveName), live);
      entry.data.push({ dir: relative(config.appDataRoot, folder).split(sep).join("/"), archive: archiveName });
    }
  } finally {
    if (stop) {
      // Even when the copy failed or the job was cancelled: an app stopped for a backup
      // must not stay down because of it. Its own time limit, as the job's signal may be
      // the reason we are here.
      ctx.log(`  Starting ${name} again`);
      const code = await processRunner.run([...composeCommand(docker(), name, dir), "start", ...running], {
        cwd: dir, signal: AbortSignal.timeout(5 * 60_000), onLine: line => ctx.log(line),
      }).catch(() => -1);
      if (code !== 0) {
        restartFailed = true;
        ctx.log(`  ⚠ Could not start ${name} again (docker compose start: ${code === -1 ? "did not run" : `exit code ${code}`}); start it from the dashboard`);
      }
    }
  }
  if (row) {
    const { id: _id, updatedAt: _at, ...rest } = row;
    entry.row = rest;
  }
  return { entry, restartFailed };
}

/** Archive config.toml, a database snapshot, samba.conf and certs/ into `<partial>/system.tar.gz`. */
async function backUpSystem(ctx: JobContext, partial: string): Promise<void> {
  const snapshotDir = join(partial, ".system");
  await mkdir(snapshotDir);
  try {
    snapshotDatabase(join(snapshotDir, "storage.db"));
    const fromRuntime: string[] = [];
    for (const entry of SYSTEM_ENTRIES) {
      if (entry !== "storage.db" && await exists(join(runtimeDir(), entry))) fromRuntime.push(entry);
    }
    const argv = [tar(), "-czf", join(partial, SYSTEM_ARCHIVE), "--numeric-owner"];
    if (fromRuntime.length > 0) argv.push("-C", runtimeDir(), ...fromRuntime);
    argv.push("-C", snapshotDir, "storage.db");
    await ctx.exec(argv, partial, "tar");
  } finally {
    await tidy(ctx, snapshotDir);
  }
}

/**
 * Take a backup. Apps another job holds, or whose backup fails, are reported and left out;
 * the rest carry on, and the job fails at the end naming them, with the backup kept.
 *
 * Written to a hidden folder and renamed into place last, so a backup that did not finish
 * is never listed or restored from.
 */
export async function runBackup(ctx: JobContext, req: BackupRequest): Promise<string> {
  const now = new Date();
  await mkdir(folder(), { recursive: true, mode: 0o700 });
  const id = await freeId(backupIdFor(now));
  const partial = join(folder(), `.${id}.partial`);
  await rm(partial, { recursive: true, force: true });
  // Not readable by others: the system part holds password hashes and the sign-in secret.
  await mkdir(partial, { mode: 0o700 });

  try {
    const manifest: BackupManifest = {
      format: FORMAT, id, createdAt: now.toISOString(), version: process.env.APP_VERSION ?? "dev",
      hostname: hostname(), dataRoot: config.appDataRoot, system: null, apps: [],
    };
    const total = req.apps.length + (req.system ? 1 : 0);
    let done = 0;

    if (req.system) {
      ctx.step("Backing up the system (settings and database)");
      await backUpSystem(ctx, partial);
      manifest.system = SYSTEM_ARCHIVE;
      ctx.progress(++done, total);
    }

    const failed: string[] = [];
    const down: string[] = [];
    for (const name of req.apps) {
      ctx.throwIfCancelled();
      ctx.step(`Backing up ${name}`);
      try {
        const held = await ctx.withStack(name, async () => {
          const { entry, restartFailed } = await backUpApp(ctx, name, partial);
          manifest.apps.push(entry);
          if (restartFailed) down.push(name);
        });
        if (!held) { ctx.log(`  Skipped: another job is working on ${name}`); failed.push(name); }
      } catch (err) {
        if (ctx.signal.aborted) throw err;
        ctx.log(`  ✕ ${err instanceof Error ? err.message : String(err)}`);
        failed.push(name);
        await tidy(ctx, join(partial, "apps", name));
      }
      ctx.progress(++done, total);
    }

    if (!manifest.system && manifest.apps.length === 0) throw new JobError("Nothing was backed up");
    await writeFile(join(partial, MANIFEST), JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
    await rename(partial, backupPath(id));
    ctx.log(`Backup ${id} saved in ${folder()}`);
    const problems = [
      failed.length > 0 ? `saved without: ${failed.join(", ")}` : null,
      down.length > 0 ? `could not start again: ${down.join(", ")}` : null,
    ].filter(Boolean);
    if (problems.length > 0) throw new JobError(`Backup ${id} ${problems.join("; ")}`);
    return id;
  } catch (err) {
    await tidy(ctx, partial);
    throw err;
  }
}

// ─── Restoring ──────────────────────────────────────────────────────────────

/** What to restore from a backup. */
export interface RestoreRequest {
  id:     string;
  system: boolean;
  apps:   string[];
}

async function extract(ctx: JobContext, archivePath: string, into: string): Promise<void> {
  await mkdir(into, { recursive: true });
  // -p: permissions as archived. Owners are restored too when running as root, by number,
  // since the user names the archive recorded may not exist here.
  await ctx.exec([tar(), "-xzf", archivePath, "--numeric-owner", "-p", "-C", into], into, "tar");
}

/**
 * Stage the system part, for {@link applyPendingRestore} to put in place at the next start.
 * Unpacked beside the staging folder and renamed onto it, so a half-unpacked staging is
 * never taken as ready.
 */
/** Throw unless `path` is a SQLite database that passes a quick integrity check. */
function checkDatabase(path: string): void {
  let db: Database | null = null;
  try {
    db = new Database(path, { readonly: true });
    const row = db.query("PRAGMA quick_check").get() as Record<string, unknown> | null;
    if (Object.values(row ?? {})[0] !== "ok") throw new Error("integrity check failed");
  } catch (e) {
    throw new JobError(`The database in this backup cannot be used: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    db?.close();
  }
}

async function stageSystem(ctx: JobContext, backup: string, m: BackupManifest): Promise<void> {
  if (!m.system) throw new JobError("This backup has no system part");
  const staged = join(runtimeDir(), PENDING_DIR);
  const partial = `${staged}.partial`;
  // A restore staged earlier stays in place until this one is: moved aside, and moved back
  // if this one cannot be put there. One an earlier attempt could not move back is put
  // back now, before anything else, rather than taken for clutter.
  const previous = staged + PREVIOUS_SUFFIX;
  if (!(await exists(staged)) && await exists(previous)) await rename(previous, staged);
  await rm(partial, { recursive: true, force: true });
  await mkdir(partial, { mode: 0o700 });
  let movedPrevious = false;
  try {
    await extract(ctx, join(backup, m.system), partial);
    // Only the system entries, each a real file (certs a real folder), are staged: anything
    // else the archive held is removed, a link among them refused. An archived `.ready`, say,
    // must not be what marks this staging ready, nor a link the marker write follows.
    for (const name of await readdir(partial)) {
      const entry = SYSTEM_ENTRIES.find(e => e === name);
      if (!entry) { await rm(join(partial, name), { recursive: true, force: true }); continue; }
      if (!(await isReal(join(partial, name), entry === "certs" ? "dir" : "file"))) {
        throw new JobError(`The system part of this backup has an unexpected ${name}`);
      }
    }
    // Without a database the "restore" would apply settings over the current data, which
    // is not the backup's state at any moment.
    if (!(await exists(join(partial, "storage.db")))) {
      throw new JobError("The system part of this backup has no database");
    }
    // And one SQLite can open and finds sound: at the restart it replaces the live one.
    checkDatabase(join(partial, "storage.db"));
    // And one this build can start on: the check startup makes, made now, while the live
    // database is still there. A backup from a newer build, or another branch, is refused.
    const problem = await MigrationManager.compatibilityProblem(join(partial, "storage.db"));
    if (problem) throw new JobError(`The database in this backup cannot be used by this version of anpan-os: ${problem}`);
    // "wx": created here, never written through something already there.
    await writeFile(join(partial, READY_MARKER), `${m.id}\n`, { flag: "wx" });
    await rm(previous, { recursive: true, force: true });
    if (await exists(staged)) { await rename(staged, previous); movedPrevious = true; }
    await rename(partial, staged);
  } catch (err) {
    // Each step on its own, the earlier staging first; the original error is what is thrown.
    if (movedPrevious && !(await exists(staged))) {
      await rename(previous, staged).catch(e => ctx.log(`⚠ Could not put back the restore staged before (it is in ${previous}): ${(e as Error).message}`));
    }
    await tidy(ctx, partial);
    throw err;
  }
  // Committed: the new staging is in place. The earlier one is only clutter now.
  await tidy(ctx, previous);
  ctx.log("System settings and database staged: restart anpan-os to apply them");
}

/**
 * Restore one app: stop it if it is here, move its folder and data folders aside, unpack
 * the backup in their place, put its row back, and start the services that were running
 * when it was backed up. The moved-aside copies are deleted only once all of that worked;
 * on failure the new files go and the old ones are moved back.
 *
 * Stopped, not taken down: `down` removes the containers, and with them the link to any
 * anonymous volume, which a later `up` would replace with an empty one. `up` after the
 * restore recreates what the restored compose file changed and keeps those volumes.
 */
async function restoreApp(ctx: JobContext, backup: string, m: BackupManifest, app: BackupApp): Promise<void> {
  // Where the app is now, if it is here (it may have moved from CasaOS's folder to
  // anpan-os's since); else where it was.
  const dir = (await appFolder(app.name))?.dir ?? folderFor(app.name, app.origin);
  const root = config.appDataRoot;
  if (app.data.length > 0 && resolve(m.dataRoot) !== root) {
    throw new JobError(
      `${app.name}'s data was under ${m.dataRoot}, and its compose file names paths there, but this machine's `
      + `[apps] data_root is ${root}. Set data_root to ${m.dataRoot} to restore it.`,
    );
  }
  const dataDirs = app.data.map(d => ({ path: join(root, d.dir), archive: join(backup, d.archive) }));

  // Each folder must still be under the data root once links are followed: a folder on
  // the way to it that is now a link elsewhere would have the restore replace files there.
  const realRoot = await realpath(root).catch(() => root);
  for (const d of dataDirs) {
    const real = await realExisting(d.path);
    if (!within(real, realRoot)) throw new JobError(`${d.path} now leads to ${real}, outside ${root}; not restoring ${app.name}`);
  }

  // Held for the whole restore: a deploy of another app must not start mounting these
  // folders while they are replaced, nor this restore replace folders a deploy is taking.
  const reserved = reservePaths(app.name, "restore", await Promise.all([dir, ...dataDirs.map(d => d.path)].map(realExisting)));
  if (!reserved.ok) {
    const { stack, what, path } = reserved.conflict;
    throw new JobError(`${path} is in use by a ${what} of ${stack}; not restoring ${app.name}`);
  }
  try {
    // A folder that was this app's alone when backed up may hold another app's data now,
    // the stack folder included. Checked before anything is stopped or moved.
    const others = await otherAppsBinds(app.name);
    for (const path of [dir, ...dataDirs.map(d => d.path)]) {
      await refuseShared(path, others, `restoring ${app.name} would replace its data`);
    }

    const hadStack = await Bun.file(join(dir, COMPOSE_FILE)).exists();
    // The services running now, which a failed restore starts again (those, not the rest).
    const runningBefore = hadStack ? await runningServices(ctx, app.name, dir) : [];
    const rowBefore = await StackStore.findById(app.name);

    // Paths moved aside, and paths this restore wrote.
    const aside: { path: string; moved: string }[] = [];
    const written: string[] = [];
    let up = false;
    let rowWritten = false;
    const stamp = Date.now();
    try {
      if (hadStack) {
        ctx.log(`  Stopping ${app.name}`);
        await ctx.exec([...composeCommand(docker(), app.name, dir), "stop"], dir, "docker compose stop");
      }
      for (const path of [dir, ...dataDirs.map(d => d.path)]) {
        if (!(await exists(path))) continue;
        const moved = `${path}.pre-restore-${stamp}`;
        await rename(path, moved);
        aside.push({ path, moved });
      }

      // An archive inside a folder just moved aside (the backups folder can lie in an app's
      // data folder) is read from where it went.
      const located = (path: string): string => {
        const holder = aside.find(a => within(path, a.path));
        return holder ? join(holder.moved, relative(holder.path, path)) : path;
      };

      ctx.log(`  Unpacking ${app.name}'s files`);
      written.push(dir);
      await extract(ctx, located(join(backup, app.stack)), dir);
      for (const d of dataDirs) {
        ctx.log(`  Data: ${d.path}`);
        written.push(d.path);
        await extract(ctx, located(d.archive), d.path);
      }

      const row = rowFrom(app.row);
      if (row) {
        rowWritten = true;
        await StackStore.restore(app.name, row);
      }

      if (app.running.length > 0) {
        ctx.log(`  Starting ${app.running.join(", ")}`);
        ctx.throwIfCancelled();
        up = true;
        // --no-deps: the services recorded as running, not ones they depend on that were not.
        await ctx.exec([...composeCommand(docker(), app.name, dir), "up", "-d", "--no-deps", ...app.running], dir, "docker compose up");
      }
    } catch (err) {
      // Each step on its own: one that fails is reported and the rest still run, so a row
      // that cannot be written back does not also leave the app down. The restore's own
      // error is what the job reports. Not on the job's signal, which may be why we are here.
      ctx.log(`  Restore of ${app.name} failed: putting back what was there`);
      const recover = async (what: string, step: () => Promise<unknown>) => {
        try { await step(); } catch (e) { ctx.log(`  ⚠ Could not ${what}: ${e instanceof Error ? e.message : String(e)}`); }
      };
      const compose = async (args: string[]) => {
        const code = await processRunner.run([...composeCommand(docker(), app.name, dir), ...args], {
          cwd: dir, signal: AbortSignal.timeout(2 * 60_000), onLine: line => ctx.log(line),
        });
        if (code !== 0) throw new Error(`docker compose ${args[0]}: exit code ${code}`);
      };
      if (up) await recover("stop the restored app", () => compose(["stop"]));
      for (const path of written) await recover(`remove ${path}`, () => rm(path, { recursive: true, force: true }));
      for (const { path, moved } of aside) await recover(`move ${moved} back to ${path}`, () => rename(moved, path));
      if (rowWritten) {
        await recover("put the app's settings back", async () => {
          if (rowBefore) {
            const { id: _id, updatedAt: _at, ...rest } = rowBefore;
            await StackStore.restore(app.name, rest);
          } else {
            await StackStore.delete(app.name);
          }
        });
      }
      if (runningBefore.length > 0) await recover(`start ${app.name} again`, () => compose(["up", "-d", "--no-deps", ...runningBefore]));
      throw err;
    }
    // Committed: the app runs on the restored files. The backups folder, when it lay inside
    // a folder moved aside, goes back to its place first: the archives leave it out, so the
    // restored folder does not hold it, and removing the safety copy would remove every
    // backup with it. Where it cannot go back, the safety copy is kept, and named.
    // A safety copy that cannot be removed is named too, not a reason to call the restore failed.
    for (const { path, moved } of aside) {
      const backups = folder();
      if (backups !== path && within(backups, path)) {
        const went = join(moved, relative(path, backups));
        if (await exists(went)) {
          try {
            await mkdir(dirname(backups), { recursive: true });
            await rename(went, backups);
          } catch (e) {
            ctx.log(`  ⚠ The backups folder could not go back to ${backups}; it is in ${went}, kept: ${(e as Error).message}`);
            continue;
          }
        }
      }
      await tidy(ctx, moved);
    }
  } finally {
    reserved.release();
  }
}

/** Restore apps, and stage the system part, from backup `req.id`. */
export async function runRestore(ctx: JobContext, req: RestoreRequest): Promise<void> {
  const m = await getBackup(req.id);
  if (!m) throw new JobError("No such backup");
  // Checked before any app is touched, not when the system's turn comes.
  if (req.system && !m.system) throw new JobError("This backup has no system part");
  const backup = backupPath(req.id);
  const apps = req.apps.map(name => {
    const app = m.apps.find(a => a.name === name);
    if (!app) throw new JobError(`Backup ${req.id} does not contain ${name}`);
    return app;
  });

  const total = apps.length + (req.system ? 1 : 0);
  let done = 0;
  const failed: string[] = [];
  for (const app of apps) {
    ctx.throwIfCancelled();
    ctx.step(`Restoring ${app.name}`);
    try {
      const held = await ctx.withStack(app.name, () => restoreApp(ctx, backup, m, app));
      if (!held) { ctx.log(`  Skipped: another job is working on ${app.name}`); failed.push(app.name); }
    } catch (err) {
      if (ctx.signal.aborted) throw err;
      ctx.log(`  ✕ ${err instanceof Error ? err.message : String(err)}`);
      failed.push(app.name);
    }
    ctx.progress(++done, total);
  }

  // Last: the staged database holds every app's row as backed up, and replaces the live
  // one at the restart, so restoring apps first loses nothing the restart would keep.
  if (req.system) {
    ctx.step("Staging the system restore");
    await stageSystem(ctx, backup, m);
    ctx.progress(++done, total);
  }
  if (failed.length > 0) throw new JobError(`Not restored: ${failed.join(", ")}`);
}

// ─── Importing an uploaded backup ───────────────────────────────────────────

/**
 * `path` with links followed as far as it exists: the real path of its nearest existing
 * ancestor, with the rest appended.
 */
async function realExisting(path: string): Promise<string> {
  const rest: string[] = [];
  let at = resolve(path);
  for (;;) {
    const real = await realpath(at).catch(() => null);
    if (real) return join(real, ...rest.reverse());
    const parent = dirname(at);
    if (parent === at) return resolve(path);
    rest.push(basename(at));
    at = parent;
  }
}

/** Whether `path` is a folder (or a regular file) itself, not a link to one. */
async function isReal(path: string, kind: "dir" | "file"): Promise<boolean> {
  const info = await lstat(path).catch(() => null);
  return kind === "dir" ? info?.isDirectory() === true : info?.isFile() === true;
}

/** Where uploads are received: a folder of its own, private whatever the backups folder's mode. */
function uploadsFolder(): string {
  return join(folder(), ".uploads");
}

/** Where an upload is received, before it is unpacked into a backup. */
export function uploadPath(uploadId: string): string {
  return join(uploadsFolder(), `${uploadId}.tar`);
}

/** An upload nobody has written to for this long is not coming back. */
const STALE_UPLOAD_MS = 24 * 60 * 60 * 1000;

/**
 * Make the uploads folder, private, and remove uploads abandoned there: a closed tab never
 * says it stopped, and a partial backup can be gigabytes. Run before an upload's first chunk.
 */
export async function prepareUploads(): Promise<void> {
  await mkdir(uploadsFolder(), { recursive: true, mode: 0o700 });
  // mkdir leaves an existing folder's mode alone; the upload may hold the sign-in secret.
  await chmod(uploadsFolder(), 0o700);
  const cutoff = Date.now() - STALE_UPLOAD_MS;
  for (const name of await readdir(uploadsFolder()).catch(() => [] as string[])) {
    const path = join(uploadsFolder(), name);
    const info = await stat(path).catch(() => null);
    if (info && info.mtimeMs < cutoff) await rm(path, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Unpack an uploaded backup (a tar of one backup folder, as Download makes it) into the
 * backups folder. The upload goes either way.
 */
export async function runImport(ctx: JobContext, uploadId: string): Promise<string> {
  const upload = uploadPath(uploadId);
  const staging = join(folder(), `.import-${uploadId}`);
  try {
    if (!(await exists(upload))) throw new JobError("The upload is not there");
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { mode: 0o700 });
    ctx.step("Unpacking the upload");
    await ctx.exec([tar(), "-xf", upload, "--numeric-owner", "-p", "-C", staging], staging, "tar");

    ctx.step("Checking the backup");
    const entries = await readdir(staging);
    const top = entries.length === 1 ? entries[0]! : null;
    // The backup's own structure must be real folders and files, not links: a link would
    // pass every check here while pointing outside the backup. (Links inside an app's data
    // are the app's own business and stay inside its archives.)
    const notBackup = new JobError("This is not an anpan-os backup: it must be a backup downloaded from anpan-os");
    if (!top || !BACKUP_ID_RE.test(top) || !(await isReal(join(staging, top), "dir"))) throw notBackup;
    const root = join(staging, top);
    if (!(await isReal(join(root, MANIFEST), "file"))) throw notBackup;
    const manifest = await readManifest(root);
    if (!manifest) throw notBackup;
    if (manifest.apps.length > 0 && !(await isReal(join(root, "apps"), "dir"))) throw notBackup;
    for (const app of manifest.apps) {
      if (!(await isReal(join(root, "apps", app.name), "dir"))) throw new JobError(`The backup is incomplete: apps/${app.name} is missing`);
    }
    const parts = [...(manifest.system ? [manifest.system] : []), ...manifest.apps.flatMap(a => [a.stack, ...a.data.map(d => d.archive)])];
    for (const part of parts) {
      if (!(await isReal(join(root, part), "file"))) throw new JobError(`The backup is incomplete: ${part} is missing`);
    }

    const id = await freeId(top);
    if (id !== top) {
      // Keep the folder name and the manifest's id in step, as listing checks.
      manifest.id = id;
      await writeFile(join(staging, top, MANIFEST), JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
    }
    await chmod(join(staging, top), 0o700);
    await rename(join(staging, top), backupPath(id));
    ctx.log(`Backup ${id} added`);
    return id;
  } finally {
    await tidy(ctx, staging);
    await tidy(ctx, upload);
  }
}
