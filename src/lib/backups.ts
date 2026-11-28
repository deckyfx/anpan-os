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
import { mkdir, readdir, rename, rm, stat, writeFile, chmod } from "node:fs/promises";
import { hostname } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { config } from "../config";
import { envConfig } from "../env-config";
import { snapshotDatabase } from "../db";
import { StackStore } from "../stores/stack-store";
import type { NewStack } from "../db/schema";
import { bins } from "./commands";
import { composeCommand, COMPOSE_FILE } from "./compose-cmd";
import { JobError, processRunner, type JobContext } from "./jobs";
import { PENDING_DIR, READY_MARKER, SYSTEM_ENTRIES } from "./pending-restore";
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
  /** Running when backed up; a restore starts it again only then. */
  wasRunning: boolean;
  /** The stack folder's archive, relative to the backup folder. */
  stack:      string;
  /** Data folders: `dir` is the folder's name under the data root. */
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

function docker(): string {
  if (!bins.docker) throw new JobError("Docker is not available on this system");
  return bins.docker;
}

function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

/** The folder name for a backup taken at `date`: `YYYYMMDD-HHMMSS`, UTC. */
export function backupIdFor(date: Date): string {
  const iso = date.toISOString(); // 2026-11-28T09:30:00.000Z
  return `${iso.slice(0, 10).replaceAll("-", "")}-${iso.slice(11, 19).replaceAll(":", "")}`;
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

const ARCHIVE_RE = (name: string) => new RegExp(`^apps/${name}/(?:stack|data-\\d{1,4})\\.tar\\.gz$`);
const DATA_DIR_RE = /^[^/\\\0]+$/;

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
    if (typeof app.live !== "boolean" || typeof app.wasRunning !== "boolean") return null;
    const archive = ARCHIVE_RE(app.name);
    if (!str(app.stack) || !archive.test(app.stack)) return null;
    if (!Array.isArray(app.data)) return null;
    const data: BackupApp["data"] = [];
    for (const d of app.data as unknown[]) {
      const entry = d as Record<string, unknown> | null;
      if (!entry || !str(entry.dir) || !str(entry.archive)) return null;
      if (!DATA_DIR_RE.test(entry.dir) || entry.dir === "." || entry.dir === "..") return null;
      if (!archive.test(entry.archive)) return null;
      data.push({ dir: entry.dir, archive: entry.archive });
    }
    const row = app.row === null || (typeof app.row === "object" && !Array.isArray(app.row))
      ? app.row as Record<string, unknown> | null
      : undefined;
    if (row === undefined) return null;
    apps.push({ name: app.name, origin: app.origin, live: app.live, wasRunning: app.wasRunning, stack: app.stack, data, row });
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
      apps: m.apps.map(a => ({ name: a.name, live: a.live, wasRunning: a.wasRunning, dataDirs: a.data.map(d => d.dir) })),
      size: sizes.reduce((sum, n) => sum + n, 0),
    });
  }
  return out.sort((a, b) => b.id.localeCompare(a.id));
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
 * The data folders of a stack, read from Compose's resolved configuration: the first
 * folder under the data root of each bind source there. Everything else the stack mounts
 * is logged as not included.
 */
async function dataFolders(ctx: JobContext, name: string, dir: string): Promise<string[]> {
  const out = await processRunner.capture([...composeCommand(docker(), name, dir), "config", "--format", "json"], { cwd: dir, signal: ctx.signal });
  ctx.throwIfCancelled();
  if (out.code !== 0) {
    const detail = out.stderr.trim().split("\n").slice(-2).join(" ");
    throw new JobError(`Docker Compose rejected ${name}'s file: ${detail || `exit code ${out.code}`}`);
  }
  let resolved: { services?: Record<string, { volumes?: { type?: string; source?: string }[] }> };
  try { resolved = JSON.parse(out.stdout); } catch { throw new JobError(`Could not read ${name}'s compose configuration`); }

  const root = config.appDataRoot;
  const folders = new Set<string>();
  const skipped = new Set<string>();
  for (const service of Object.values(resolved.services ?? {})) {
    for (const v of service.volumes ?? []) {
      if (!v.source) continue;
      if (v.type === "volume") { skipped.add(`named volume "${v.source}"`); continue; }
      if (v.type !== "bind") continue;
      const source = resolve(v.source);
      if (within(source, dir)) continue; // in the stack folder's own archive
      if (source !== root && within(source, root)) {
        folders.add(join(root, relative(root, source).split(sep)[0]!));
      } else {
        skipped.add(source);
      }
    }
  }
  for (const what of [...skipped].sort()) ctx.log(`  Not included: ${what} (outside ${root})`);

  // Only folders that are there: a bind to a path Docker has not created yet holds nothing.
  const present: string[] = [];
  for (const f of [...folders].sort()) {
    if ((await stat(f).catch(() => null))?.isDirectory()) present.push(f);
  }
  return present;
}

/** The services of `name` that are running now. */
async function runningServices(ctx: JobContext, name: string, dir: string): Promise<string[]> {
  const out = await processRunner.capture([...composeCommand(docker(), name, dir), "ps", "--status", "running", "--services"], { cwd: dir, signal: ctx.signal });
  ctx.throwIfCancelled();
  if (out.code !== 0) throw new JobError(`Could not read ${name}'s state (docker compose ps: exit code ${out.code})`);
  return out.stdout.split("\n").map(s => s.trim()).filter(Boolean);
}

/**
 * Archive the contents of `dir` into `out`. When `live`, a file that changed while it was
 * read is a warning (GNU tar's exit code 1), not a failure: that is what copying a running
 * app means, and the user chose it.
 */
async function archive(ctx: JobContext, dir: string, out: string, live: boolean): Promise<void> {
  ctx.throwIfCancelled();
  const code = await processRunner.run([tar(), "-czf", out, "--numeric-owner", "-C", dir, "."], {
    cwd: dir, signal: ctx.signal, onLine: line => ctx.log(line),
  });
  ctx.throwIfCancelled();
  if (code === 1 && live) { ctx.log(`  Some files in ${dir} changed while they were copied`); return; }
  if (code !== 0) throw new JobError(`Could not archive ${dir} (tar: exit code ${code})`);
}

/** Back up one app into `<partial>/apps/<name>/`. */
async function backUpApp(ctx: JobContext, name: string, partial: string): Promise<BackupApp> {
  const found = await appFolder(name);
  if (!found) throw new JobError(`${name} has no compose file`);
  const { dir, origin } = found;
  const row = await StackStore.findById(name);
  const live = row?.backupLive ?? false;

  const data = await dataFolders(ctx, name, dir);
  const running = await runningServices(ctx, name, dir);
  const target = join(partial, "apps", name);
  await mkdir(target, { recursive: true });

  const stop = !live && running.length > 0;
  if (stop) {
    ctx.log(`  Stopping ${name} while its files are copied`);
    await ctx.exec([...composeCommand(docker(), name, dir), "stop"], dir, "docker compose stop");
  }
  const entry: BackupApp = {
    name, origin, live, wasRunning: running.length > 0, stack: `apps/${name}/stack.tar.gz`, data: [], row: null,
  };
  try {
    await archive(ctx, dir, join(partial, entry.stack), live);
    for (const [i, folder] of data.entries()) {
      const archiveName = `apps/${name}/data-${i}.tar.gz`;
      ctx.log(`  Data: ${folder}`);
      await archive(ctx, folder, join(partial, archiveName), live);
      entry.data.push({ dir: relative(config.appDataRoot, folder), archive: archiveName });
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
      if (code !== 0) ctx.log(`  ⚠ Could not start ${name} again (docker compose start: ${code === -1 ? "did not run" : `exit code ${code}`}); start it from the dashboard`);
    }
  }
  if (row) {
    const { id: _id, updatedAt: _at, ...rest } = row;
    entry.row = rest;
  }
  return entry;
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
    await rm(snapshotDir, { recursive: true, force: true });
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
    for (const name of req.apps) {
      ctx.throwIfCancelled();
      ctx.step(`Backing up ${name}`);
      try {
        const held = await ctx.withStack(name, async () => { manifest.apps.push(await backUpApp(ctx, name, partial)); });
        if (!held) { ctx.log(`  Skipped: another job is working on ${name}`); failed.push(name); }
      } catch (err) {
        if (ctx.signal.aborted) throw err;
        ctx.log(`  ✕ ${err instanceof Error ? err.message : String(err)}`);
        failed.push(name);
        await rm(join(partial, "apps", name), { recursive: true, force: true });
      }
      ctx.progress(++done, total);
    }

    if (!manifest.system && manifest.apps.length === 0) throw new JobError("Nothing was backed up");
    await writeFile(join(partial, MANIFEST), JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
    await rename(partial, backupPath(id));
    ctx.log(`Backup ${id} saved in ${folder()}`);
    if (failed.length > 0) throw new JobError(`Backup ${id} saved without: ${failed.join(", ")}`);
    return id;
  } catch (err) {
    await rm(partial, { recursive: true, force: true });
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
async function stageSystem(ctx: JobContext, backup: string, m: BackupManifest): Promise<void> {
  if (!m.system) throw new JobError("This backup has no system part");
  const staged = join(runtimeDir(), PENDING_DIR);
  const partial = `${staged}.partial`;
  await rm(partial, { recursive: true, force: true });
  await mkdir(partial, { mode: 0o700 });
  try {
    await extract(ctx, join(backup, m.system), partial);
    await writeFile(join(partial, READY_MARKER), `${m.id}\n`);
    await rm(staged, { recursive: true, force: true });
    await rename(partial, staged);
  } catch (err) {
    await rm(partial, { recursive: true, force: true });
    throw err;
  }
  ctx.log("System settings and database staged: restart anpan-os to apply them");
}

/**
 * Restore one app: stop it if it is here, move its folder and data folders aside, unpack
 * the backup in their place, put its row back, and start it if it was running when backed
 * up. The moved-aside copies are deleted only once all of that worked; on failure the new
 * files go and the old ones are moved back.
 */
async function restoreApp(ctx: JobContext, backup: string, m: BackupManifest, app: BackupApp): Promise<void> {
  const dir = folderFor(app.name, app.origin);
  const root = config.appDataRoot;
  if (app.data.length > 0 && resolve(m.dataRoot) !== root) {
    throw new JobError(
      `${app.name}'s data was under ${m.dataRoot}, and its compose file names paths there, but this machine's `
      + `[apps] data_root is ${root}. Set data_root to ${m.dataRoot} to restore it.`,
    );
  }
  const dataDirs = app.data.map(d => ({ path: join(root, d.dir), archive: join(backup, d.archive) }));

  const hadStack = await Bun.file(join(dir, COMPOSE_FILE)).exists();
  const wasRunning = hadStack && (await runningServices(ctx, app.name, dir)).length > 0;
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
      await ctx.exec([...composeCommand(docker(), app.name, dir), "down"], dir, "docker compose down");
    }
    for (const path of [dir, ...dataDirs.map(d => d.path)]) {
      if (!(await exists(path))) continue;
      const moved = `${path}.pre-restore-${stamp}`;
      await rename(path, moved);
      aside.push({ path, moved });
    }

    ctx.log(`  Unpacking ${app.name}'s files`);
    written.push(dir);
    await extract(ctx, join(backup, app.stack), dir);
    for (const d of dataDirs) {
      ctx.log(`  Data: ${d.path}`);
      written.push(d.path);
      await extract(ctx, d.archive, d.path);
    }

    const row = rowFrom(app.row);
    if (row) {
      rowWritten = true;
      await StackStore.restore(app.name, row);
    }

    if (app.wasRunning) {
      ctx.log(`  Starting ${app.name}`);
      ctx.throwIfCancelled();
      up = true;
      await ctx.exec([...composeCommand(docker(), app.name, dir), "up", "-d"], dir, "docker compose up");
    }
  } catch (err) {
    ctx.log(`  Restore of ${app.name} failed: putting back what was there`);
    const timeout = () => AbortSignal.timeout(2 * 60_000);
    const quiet = { onLine: (line: string) => ctx.log(line) };
    if (up) await processRunner.run([...composeCommand(docker(), app.name, dir), "down"], { cwd: dir, signal: timeout(), ...quiet }).catch(() => -1);
    for (const path of written) await rm(path, { recursive: true, force: true });
    for (const { path, moved } of aside) await rename(moved, path).catch(e => ctx.log(`  ⚠ Could not move ${moved} back: ${(e as Error).message}`));
    if (rowWritten) {
      if (rowBefore) {
        const { id: _id, updatedAt: _at, ...rest } = rowBefore;
        await StackStore.restore(app.name, rest);
      } else {
        await StackStore.delete(app.name);
      }
    }
    if (wasRunning) {
      await processRunner.run([...composeCommand(docker(), app.name, dir), "up", "-d"], { cwd: dir, signal: timeout(), ...quiet }).catch(() => -1);
    }
    throw err;
  }
  for (const { moved } of aside) await rm(moved, { recursive: true, force: true });
}

/** Restore apps, and stage the system part, from backup `req.id`. */
export async function runRestore(ctx: JobContext, req: RestoreRequest): Promise<void> {
  const m = await getBackup(req.id);
  if (!m) throw new JobError("No such backup");
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

/** Where an upload is received, before it is unpacked into a backup. */
export function uploadPath(uploadId: string): string {
  return join(folder(), `.upload-${uploadId}.tar`);
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
    const manifest = top && BACKUP_ID_RE.test(top) ? await readManifest(join(staging, top)) : null;
    if (!top || !manifest) throw new JobError("This is not an anpan-os backup: it must be a backup downloaded from anpan-os");
    const parts = [...(manifest.system ? [manifest.system] : []), ...manifest.apps.flatMap(a => [a.stack, ...a.data.map(d => d.archive)])];
    for (const part of parts) {
      if (!(await exists(join(staging, top, part)))) throw new JobError(`The backup is incomplete: ${part} is missing`);
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
    await rm(staging, { recursive: true, force: true });
    await rm(upload, { force: true });
  }
}
