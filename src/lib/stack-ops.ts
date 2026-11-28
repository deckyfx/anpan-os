/**
 * The stack operations that run as jobs: install, redeploy, update, update-all, migrate and
 * repair.
 *
 * Each has two halves:
 * - A `check…` function the route calls before starting a job, so a request that cannot
 *   succeed gets a real status code (404, 409, 422) instead of a job that fails at once.
 * - A `run…` function, the job body, which does the work and reports through its
 *   {@link JobContext}.
 *
 * An install or redeploy writes every file and the stack's row *before* the first
 * `docker compose up`. The browser used to send the metadata and the `.env` afterwards, in
 * separate requests, so the first start ran without the env file, and a tab closed
 * mid-install left a stack with neither.
 */
import { join, dirname } from "node:path";
import { chown, mkdir, rm, rmdir, stat } from "node:fs/promises";
import { parse } from "yaml";
import { config } from "../config";
import { bins } from "./commands";
import { DockerClient, normalizeComposePath } from "./docker";
import { JobError, processRunner, type JobContext } from "./jobs";
import { withPlatformDefaults, envValue } from "./app-env";
import { resolveWithin } from "./path-guard";
import { describeConflicts, findPortConflicts, publishedPorts } from "./port-check";
import { StackStore } from "../stores/stack-store";
import { CASAOS_APPS_DIR } from "./platform";
import { COMPOSE_FILE, composeCommand } from "./compose-cmd";
import { PROJECT_NAME_RE } from "../constants/stack";
import { invalidateOriginCache } from "../plugins/routeDocker";
import { buildComposeSourceReport, adoptComposeFile, findOrphanServices } from "./compose-source";

/** Stack metadata a deploy may set: what the home tile and its links show. */
export interface StackMeta {
  title?:       string | null;
  icon?:        string | null;
  tagline?:     string | null;
  portMap?:     string | null;
  scheme?:      string | null;
  indexPath?:   string | null;
  mainService?: string | null;
  address?:     string | null;
  note?:        string | null;
  openMode?:    string | null;
}

export interface DeployRequest {
  name:    string;
  compose: string;
  /** The stack's `.env`. Omitted keeps the current file (redeploy) or none (install). */
  env?:    string;
  meta?:   StackMeta;
}

/** A refusal for the route to send as it stands. */
export interface Refusal {
  status: 404 | 409 | 422 | 503;
  error:  string;
}

export function stackDir(name: string): string {
  return join(config.composeFolder, name);
}

function docker(): string {
  if (!bins.docker) throw new JobError("Docker is not available on this system");
  return bins.docker;
}

function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

async function readIfExists(path: string): Promise<string | null> {
  const file = Bun.file(path);
  return (await file.exists()) ? file.text() : null;
}

/**
 * The compose file must parse and define at least one service, and a top-level `name:`, if
 * present, must be the stack's own.
 *
 * Every Compose command here runs with `-p <stack>`, which overrides `name:`. A file naming
 * another project would otherwise be checked, started and cleaned up under different
 * projects depending on who ran Compose, so it is refused instead of quietly renamed.
 */
export function checkComposeText(compose: string, stack?: string): Refusal | null {
  let doc: unknown;
  try {
    doc = parse(compose);
  } catch (err) {
    return { status: 422, error: `The compose file is not valid YAML: ${err instanceof Error ? err.message : String(err)}` };
  }
  const services = (doc as { services?: unknown } | null)?.services;
  if (!services || typeof services !== "object" || Object.keys(services).length === 0) {
    return { status: 422, error: "The compose file defines no services" };
  }
  const named = (doc as { name?: unknown }).name;
  if (stack !== undefined && named !== undefined && named !== null && String(named) !== stack) {
    return { status: 422, error: `The compose file is named "${String(named)}", but the stack is "${stack}". Make them match, or remove the top-level name:.` };
  }
  return null;
}

/**
 * Whether `name` can be installed.
 *
 * Installing over an existing stack used to overwrite its compose file without a word. A
 * name is taken when its stack folder exists (it may hold files the user put there), or
 * when Docker has containers in a project of that name, which may belong to CasaOS or be
 * started by hand. If Docker cannot be asked, the name is not known to be free: 503.
 *
 * Called by the route for a fast answer, and again inside the job, under the stack's claim,
 * because another install of the same name may have finished in between.
 */
export async function checkInstall(req: DeployRequest): Promise<Refusal | null> {
  if (!PROJECT_NAME_RE.test(req.name)) {
    return { status: 422, error: `"${req.name}" cannot be a stack name: use lowercase letters, digits, "-" and "_", starting with a letter or digit.` };
  }
  const bad = checkComposeText(req.compose, req.name);
  if (bad) return bad;
  if (await exists(stackDir(req.name))) {
    return { status: 409, error: `A stack named "${req.name}" already exists. Choose another name, or edit that stack.` };
  }
  const containers = await DockerClient.listProjectContainers(req.name);
  if (!containers.ok) {
    return { status: 503, error: `Could not ask Docker whether "${req.name}" is in use: ${containers.error}` };
  }
  if (containers.data.length > 0) {
    return { status: 409, error: `Docker already has a project named "${req.name}". Choose another name.` };
  }
  return null;
}

/** Whether `name` can be redeployed: only a stack whose compose file anpan-os holds. */
export async function checkRedeploy(req: DeployRequest): Promise<Refusal | null> {
  const bad = checkComposeText(req.compose, req.name);
  if (bad) return bad;
  if (!(await Bun.file(join(stackDir(req.name), COMPOSE_FILE)).exists())) {
    return { status: 404, error: `Stack "${req.name}" is not managed by anpan-os` };
  }
  return null;
}

/** The start of every Compose command for `name`; see {@link composeCommand}. */
function compose(name: string, dir: string): string[] {
  return composeCommand(docker(), name, dir);
}

/**
 * `docker compose up` for `name`, with --force-recreate when containers came from another file.
 *
 * `onLaunch` runs just before Compose starts, after every check that could still stop it
 * (cancellation included). A caller that must clean up after `up` knows from it that there
 * may be something to clean.
 */
async function composeUp(ctx: JobContext, name: string, dir: string, extra: string[] = [], onLaunch?: () => void): Promise<void> {
  const args = [...compose(name, dir), "up", "-d", ...extra];
  // Containers created from a different compose file keep that file's labels unless
  // recreated, which leaves the project split across two sources.
  if (!extra.includes("--force-recreate") && await DockerClient.hasComposeDrift(name, join(dir, COMPOSE_FILE))) {
    args.push("--force-recreate");
  }
  // ctx.exec checks for cancellation and then spawns, with nothing in between; checking
  // here first means onLaunch only runs when that check will pass.
  ctx.throwIfCancelled();
  onLaunch?.();
  await ctx.exec(args, dir, "docker compose up");
}

/**
 * Validate the files now in `dir` the way Compose will read them, with every variable
 * substituted, and return the resolved configuration.
 */
async function resolveConfig(ctx: JobContext, name: string, dir: string): Promise<unknown> {
  const out = await processRunner.capture([...compose(name, dir), "config", "--format", "json"], { cwd: dir, signal: ctx.signal });
  ctx.throwIfCancelled();
  if (out.code !== 0) {
    const detail = out.stderr.trim().split("\n").slice(-3).join(" ");
    throw new JobError(`Docker Compose rejected the file: ${detail || `exit code ${out.code}`}`);
  }
  try {
    return JSON.parse(out.stdout);
  } catch {
    throw new JobError("Could not read the resolved compose configuration");
  }
}

/**
 * The user and group the stack's files should belong to: the `PUID`/`PGID` Compose gives
 * the services that ask for them, else `[apps]` in config.toml.
 *
 * Compose takes a variable from its own environment before `.env`, and it runs with
 * anpan-os's environment. So a `PUID` anpan-os was started with wins over the stack's
 * `.env`, here as in Compose. A value that is not a plain number (empty, say) falls back.
 */
export function ownerFor(env: string, shell: Record<string, string | undefined> = process.env): { puid: number; pgid: number } {
  const fallback = config.appIds;
  const read = (key: string, dflt: number) => {
    const raw = shell[key] ?? envValue(env, key);
    return raw !== null && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : dflt;
  };
  return { puid: read("PUID", fallback.puid), pgid: read("PGID", fallback.pgid) };
}

/**
 * Create the host folders the stack binds under the app data root, owned by $PUID:$PGID.
 *
 * Docker would create a missing bind source itself, but as root, and an image that drops
 * to $PUID then cannot write to its own config folder. Only folders under the data root are
 * created, and only when the path stays there through every symlink on the way; anywhere
 * else on the host is the user's business. A bind with `create_host_path: false` is left
 * alone, as Compose would leave it.
 *
 * Every folder created is pushed onto `created`, deepest first, as it is made, so a failed
 * install can remove them again even when this throws part way.
 */
async function prepareDataFolders(
  ctx: JobContext, resolved: unknown, owner: { puid: number; pgid: number }, created: string[],
): Promise<void> {
  const root = config.appDataRoot;
  const services = (resolved as { services?: Record<string, { volumes?: unknown[] }> } | null)?.services ?? {};
  const sources = new Set<string>();
  for (const svc of Object.values(services)) {
    for (const v of svc?.volumes ?? []) {
      const vol = v as { type?: string; source?: string; bind?: { create_host_path?: boolean } };
      if (vol.type !== "bind" || !vol.source || !vol.source.startsWith(`${root}/`)) continue;
      if (vol.bind?.create_host_path === false) continue;
      sources.add(vol.source);
    }
  }
  const asRoot = process.getuid?.() === 0;
  for (const source of sources) {
    if (await exists(source)) continue;
    // A source with a dot in its last part is most likely a file mount; Docker would make
    // it a folder, so leave it for the user to create.
    if (/\.[A-Za-z0-9]+$/.test(source)) continue;
    try {
      resolveWithin(source, root);
    } catch {
      ctx.log(`Skipped ${source}: it leads outside ${root} through a symlink`);
      continue;
    }
    // The folders this creates: from the source up to the first one that already exists,
    // never above the data root. Only those change owner.
    const missing: string[] = [];
    for (let dir = source; dir.startsWith(`${root}/`) && !(await exists(dir)); dir = dirname(dir)) missing.push(dir);
    // The data root itself may not exist yet on a new machine. It is made, but never
    // recorded: an undo removes the app's folders, not the root they all share.
    await mkdir(root, { recursive: true });
    // Top down, one at a time, so `created` only ever names folders this made.
    for (const dir of [...missing].reverse()) {
      await mkdir(dir);
      created.unshift(dir);
      if (asRoot) await chown(dir, owner.puid, owner.pgid).catch(() => {});
    }
    ctx.log(`Created ${source}${asRoot ? ` (owner ${owner.puid}:${owner.pgid})` : ""}`);
  }
}

/** The metadata a stack row holds, without its key and timestamp: what an undo puts back. */
type RowSnapshot = Omit<NonNullable<Awaited<ReturnType<typeof StackStore.findById>>>, "id" | "updatedAt">;

/** How far an install got, so a failure undoes exactly that. */
interface InstallProgress {
  folder: boolean;
  /** Bind folders under the data root this install made, deepest first. */
  dataDirs: string[];
  /** Whether `claim` wrote the row, and what the row was before (null: there was none). */
  row: { wrote: boolean; before: RowSnapshot | null };
  /** Whether `docker compose up` was launched; set only once nothing can stop it first. */
  up: boolean;
}

/**
 * Install or redeploy a stack: write its files, check them, record the stack, start it.
 *
 * Files are written before checking because Compose must read them from the stack folder
 * (relative paths and `env_file:` resolve there).
 *
 * When something fails:
 * - A redeploy that fails writing or checking its files restores the previous ones. One that
 *   fails later keeps its new files, which passed the checks and are what the user is trying
 *   to make work.
 * - An install undoes everything it did, so pressing Install again works. Otherwise the
 *   folder and row it made would answer "already exists" for a stack that never started.
 */
export async function runDeploy(ctx: JobContext, mode: "install" | "redeploy", req: DeployRequest): Promise<void> {
  const dir = stackDir(req.name);
  const composePath = join(dir, COMPOSE_FILE);
  const envPath = join(dir, ".env");

  if (mode === "install") {
    // Again, now that this job holds the name: another install may have finished since the
    // route checked. Refused here before anything is written, so there is nothing to undo.
    const refused = await checkInstall(req);
    if (refused) throw new JobError(refused.error);
  }

  const previous = mode === "redeploy"
    ? { compose: await readIfExists(composePath), env: await readIfExists(envPath) }
    : null;
  const done: InstallProgress = { folder: false, dataDirs: [], row: { wrote: false, before: null }, up: false };

  try {
    ctx.step("Writing files");
    if (mode === "install") {
      await mkdir(config.composeFolder, { recursive: true });
      // Not recursive: an existing folder fails here rather than being taken over.
      await mkdir(dir);
      done.folder = true;
    }
    const baseEnv = req.env ?? previous?.env ?? "";
    const { env, added } = withPlatformDefaults(baseEnv, req.compose, req.name);

    let resolved: unknown;
    try {
      // Inside the restore boundary: a redeploy whose .env write fails after the compose
      // write must not leave the new, unchecked compose file beside the old .env.
      await Bun.write(composePath, req.compose);
      // An install with nothing to put in .env writes none; a redeploy that had one updates it.
      if (env || (previous && previous.env !== null)) await Bun.write(envPath, env);
      if (added.length > 0) ctx.log(`Added to .env: ${added.join(", ")}`);

      ctx.step("Checking the compose file");
      resolved = await resolveConfig(ctx, req.name, dir);

      ctx.step("Checking ports");
      const conflicts = await findPortConflicts(publishedPorts(resolved), req.name);
      if (conflicts.length > 0) throw new JobError(`Port conflict: ${describeConflicts(conflicts)}`);
    } catch (err) {
      if (previous) {
        if (previous.compose !== null) await Bun.write(composePath, previous.compose);
        if (previous.env !== null) await Bun.write(envPath, previous.env);
        else await rm(envPath, { force: true });
        ctx.log("Restored the previous compose and .env files");
      }
      throw err;
    }

    await prepareDataFolders(ctx, resolved, ownerFor(env), done.dataDirs);

    // The row is written before `up`, with managed set, so the stack is anpan-os's from the
    // moment its containers exist, whatever the home page's poll sees first. The row as it
    // was is kept first: the poll may have made one, and an undo must not delete or keep
    // overwriting what it did not create.
    if (mode === "install") done.row.before = snapshotOf(await StackStore.findById(req.name));
    await StackStore.claim(req.name, req.meta ?? {});
    done.row.wrote = true;
    invalidateOriginCache(req.name);

    ctx.step("Starting containers");
    await composeUp(ctx, req.name, dir, [], () => { done.up = true; });
  } catch (err) {
    if (mode === "install" && done.folder) await undoInstall(ctx, req.name, dir, done);
    throw err;
  }
}

function snapshotOf(row: Awaited<ReturnType<typeof StackStore.findById>>): RowSnapshot | null {
  if (!row) return null;
  const { id: _id, updatedAt: _at, ...rest } = row;
  return rest;
}

/**
 * Undo a failed install: whatever containers and networks `up` got as far as making, then
 * the stack folder, the empty data folders it made, and its row. Named volumes stay (`down`
 * without -v). `done` says which of those the install reached.
 *
 * The row goes only if this install created it. One that was there before (the stack poll
 * makes rows for what Docker shows) gets its earlier fields and `managed` back.
 *
 * When `down` itself fails, containers may remain, so the folder and row are kept: they
 * are what deleting the stack from the dashboard, or a retry of `down`, needs.
 *
 * Runs even when the job was cancelled, so it does not use the job's own signal. It has a
 * time limit of its own instead: a Docker that hangs must not keep the job running forever.
 */
async function undoInstall(ctx: JobContext, name: string, dir: string, done: InstallProgress): Promise<void> {
  ctx.log("Install failed: removing what it created");
  if (done.up) {
    const code = await processRunner.run([...compose(name, dir), "down", "--remove-orphans"], {
      cwd: dir, signal: AbortSignal.timeout(2 * 60_000), onLine: line => ctx.log(line),
    }).catch(() => -1);
    if (code !== 0) {
      ctx.log(`Could not remove the stack's containers (docker compose down: ${code === -1 ? "did not run" : `exit code ${code}`}). `
        + `Its files are kept: delete "${name}" from the dashboard to clean up.`);
      return;
    }
  }
  await rm(dir, { recursive: true, force: true });
  // Deepest first, and only while empty: a folder something wrote into stays.
  for (const created of done.dataDirs) await rmdir(created).catch(() => {});
  if (done.row.wrote) {
    if (done.row.before) await StackStore.updateMeta(name, done.row.before);
    else await StackStore.delete(name);
    invalidateOriginCache(name);
  }
}

/** Where `name`'s compose file lives: anpan-os's folder, else CasaOS's. */
export async function updatableDir(name: string): Promise<string | null> {
  if (await Bun.file(join(stackDir(name), COMPOSE_FILE)).exists()) return stackDir(name);
  if (await Bun.file(join(CASAOS_APPS_DIR, name, COMPOSE_FILE)).exists()) return join(CASAOS_APPS_DIR, name);
  return null;
}

/** Pull a stack's images and recreate what changed. */
export async function runUpdate(ctx: JobContext, name: string, dir: string): Promise<void> {
  ctx.step(`Pulling images for ${name}`);
  await ctx.exec([...compose(name, dir), "pull"], dir, "docker compose pull");
  ctx.step(`Restarting ${name} on the new images`);
  await composeUp(ctx, name, dir);
}

/**
 * Update several stacks one after another.
 *
 * A stack that fails, or that another job holds, is reported and skipped; the rest carry on.
 * The job fails at the end if any stack did not update, naming them.
 */
export async function runUpdateAll(ctx: JobContext, stacks: string[]): Promise<void> {
  const failed: string[] = [];
  for (const [i, name] of stacks.entries()) {
    ctx.throwIfCancelled();
    ctx.progress(i, stacks.length);
    const dir = await updatableDir(name);
    if (!dir) {
      ctx.log(`✕ ${name}: no compose file found, skipped`);
      failed.push(name);
      continue;
    }
    let error: string | null = null;
    const ran = await ctx.withStack(name, async () => {
      ctx.logToStack(name, "update");
      try {
        await runUpdate(ctx, name, dir);
      } catch (err) {
        if (ctx.signal.aborted) throw err;
        error = err instanceof Error ? err.message : String(err);
      } finally {
        ctx.logToStack(null);
      }
    });
    if (!ran) error = "another job is working on this stack, skipped";
    if (error) {
      ctx.log(`✕ ${name}: ${error}`);
      failed.push(name);
    } else {
      ctx.log(`✓ ${name} updated`);
    }
  }
  ctx.progress(stacks.length, stacks.length);
  if (failed.length > 0) {
    throw new JobError(`${failed.length} of ${stacks.length} stacks did not update: ${failed.join(", ")}`);
  }
}

/**
 * Services Docker runs for `stack` that `services` does not define.
 *
 * `--remove-orphans` would delete exactly these, so a migration or repair is refused while
 * there are any.
 */
async function orphansOf(stack: string, services: Set<string>): Promise<string[]> {
  const containers = await DockerClient.listProjectContainers(stack);
  if (!containers.ok) throw new JobError(containers.error);
  return [...new Set(
    containers.data
      .map(c => c.Labels?.["com.docker.compose.service"])
      .filter((s): s is string => Boolean(s) && !services.has(s!)),
  )];
}

/** Service names a compose text defines. */
function servicesIn(compose: string): Set<string> {
  const doc = parse(compose) as { services?: Record<string, unknown> } | null;
  return new Set(Object.keys(doc?.services ?? {}));
}

/**
 * Move a CasaOS stack into anpan-os: copy its compose file, record its metadata and
 * recreate its containers from the copy.
 *
 * The orphan check now runs against the source file, before anything is written. It used to
 * run after the copy, so a refused migration still left a managed compose file behind.
 */
export async function runMigrate(ctx: JobContext, name: string, raw: string, sourcePath: string, meta: StackMeta): Promise<void> {
  ctx.step("Checking services");
  const orphans = await orphansOf(name, servicesIn(raw));
  if (orphans.length > 0) {
    throw new JobError(
      `Migration would delete these running services, which ${sourcePath} does not define: `
      + `${orphans.join(", ")}. Merge them into the compose file first.`,
    );
  }

  ctx.step("Copying the compose file");
  const dir = stackDir(name);
  const target = join(dir, COMPOSE_FILE);
  const hadFolder = await exists(dir);
  const before = await readIfExists(target);
  await mkdir(dir, { recursive: true });
  await Bun.write(target, raw);
  ctx.log(`Copied ${sourcePath} → ${target}`);

  // --force-recreate is required: unchanged containers would otherwise keep the labels of
  // the CasaOS file they were created from, leaving the project split across two files.
  ctx.step("Recreating containers from the copy");
  try {
    await composeUp(ctx, name, dir, ["--remove-orphans", "--force-recreate"]);
  } catch (err) {
    await undoMigrate(ctx, name, target, before, hadFolder);
    throw err;
  }

  // Recorded only now that the stack runs from the copy. Marked managed before, a failed
  // migration left the stack running from CasaOS while anpan-os held a copy it preferred
  // for every later update.
  await StackStore.claim(name, meta);
  invalidateOriginCache(name);
}

/**
 * After a failed migration: if no container was recreated from the copy, the stack still
 * runs from CasaOS, so the copy goes (or the file it replaced comes back) and CasaOS stays
 * the source. If some were, the stack is split between the two files and the copy is what
 * Repair needs, so it is kept and the log says so.
 */
async function undoMigrate(ctx: JobContext, name: string, target: string, before: string | null, hadFolder: boolean): Promise<void> {
  const sources = await DockerClient.listProjectComposeSources(name);
  const copy = normalizeComposePath(target);
  const moved = !sources.ok || sources.data.some(c => c.configFiles.map(normalizeComposePath).includes(copy));
  if (moved) {
    ctx.log(`Some containers already run from ${target}. It is kept: use Repair in System Doctor to finish moving the stack.`);
    return;
  }
  if (before !== null) await Bun.write(target, before);
  else if (!hadFolder) await rm(dirname(target), { recursive: true, force: true });
  else await rm(target, { force: true });
  ctx.log("Nothing was recreated from the copy, so it was removed. The stack still runs from CasaOS.");
}

/**
 * Re-anchor a stack on its managed compose file; see the repair route.
 *
 * When the managed file had to be adopted from another location and the orphan check then
 * refuses, the adopted copy is removed again, so a refused repair changes nothing.
 */
export async function runRepair(ctx: JobContext, name: string, adoptExternal = false): Promise<void> {
  ctx.step("Reading compose sources");
  const report = await buildComposeSourceReport(name);
  // The route checked this too, but the stack may have changed since: taking over an
  // external stack needs the caller's consent (?adopt=1) for the stack as it is now.
  if (report.status === "external" && !adoptExternal) {
    throw new JobError(`Stack "${name}" is managed outside anpan-os (${report.foreignPaths.join(", ")}). Repairing would take it over; ask again with adopt to confirm.`);
  }
  if (!report.needsRepair && report.status !== "external") {
    throw new JobError(`Stack "${name}" reports status "${report.status}" and does not need repair.`);
  }
  const adopted = await adoptComposeFile(report);
  if (!adopted.ok) throw new JobError(adopted.error);
  if (adopted.adoptedFrom) ctx.log(`Adopted ${adopted.adoptedFrom} → ${report.expected}`);

  ctx.step("Checking services");
  const orphanCheck = await findOrphanServices(report);
  const refuse = !orphanCheck.ok
    ? orphanCheck.error
    : orphanCheck.orphans.length > 0
      ? `Repair would delete these running services, which are missing from ${report.expected}: `
        + `${orphanCheck.orphans.join(", ")}. Merge them into the managed compose file first.`
      : null;
  if (refuse) {
    if (adopted.adoptedFrom) await rm(report.expected, { force: true });
    throw new JobError(refuse);
  }

  await StackStore.claim(name);
  ctx.step("Recreating containers");
  await composeUp(ctx, name, stackDir(name), ["--remove-orphans", "--force-recreate"]);
}
