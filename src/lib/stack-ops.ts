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
import { chown, mkdir, rm, stat } from "node:fs/promises";
import { parse } from "yaml";
import { config } from "../config";
import { bins } from "./commands";
import { DockerClient } from "./docker";
import { JobError, processRunner, type JobContext } from "./jobs";
import { withPlatformDefaults } from "./app-env";
import { describeConflicts, findPortConflicts, publishedPorts } from "./port-check";
import { StackStore } from "../stores/stack-store";
import { CASAOS_APPS_DIR } from "./platform";
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

const COMPOSE_FILE = "docker-compose.yml";

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

/** The compose file must parse and define at least one service. */
export function checkComposeText(compose: string): Refusal | null {
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
  return null;
}

/**
 * Whether `name` can be installed.
 *
 * Installing over an existing stack used to overwrite its compose file without a word.
 * A name is taken when anpan-os has a compose file for it, or Docker has containers in a
 * project of that name, which may belong to CasaOS or be started by hand.
 */
export async function checkInstall(req: DeployRequest): Promise<Refusal | null> {
  const bad = checkComposeText(req.compose);
  if (bad) return bad;
  if (await Bun.file(join(stackDir(req.name), COMPOSE_FILE)).exists()) {
    return { status: 409, error: `A stack named "${req.name}" already exists. Choose another name, or edit that stack.` };
  }
  const containers = await DockerClient.listProjectContainers(req.name);
  if (containers.ok && containers.data.length > 0) {
    return { status: 409, error: `Docker already has a project named "${req.name}". Choose another name.` };
  }
  return null;
}

/** Whether `name` can be redeployed: only a stack whose compose file anpan-os holds. */
export async function checkRedeploy(req: DeployRequest): Promise<Refusal | null> {
  const bad = checkComposeText(req.compose);
  if (bad) return bad;
  if (!(await Bun.file(join(stackDir(req.name), COMPOSE_FILE)).exists())) {
    return { status: 404, error: `Stack "${req.name}" is not managed by anpan-os` };
  }
  return null;
}

/** `docker compose up` for `name`, with --force-recreate when containers came from another file. */
async function composeUp(ctx: JobContext, name: string, dir: string, extra: string[] = []): Promise<void> {
  const args = [docker(), "compose", "up", "-d", ...extra];
  // Containers created from a different compose file keep that file's labels unless
  // recreated, which leaves the project split across two sources.
  if (!extra.includes("--force-recreate") && await DockerClient.hasComposeDrift(name, join(dir, COMPOSE_FILE))) {
    args.push("--force-recreate");
  }
  await ctx.exec(args, dir, "docker compose up");
}

/**
 * Validate the files now in `dir` the way Compose will read them, with every variable
 * substituted, and return the resolved configuration.
 */
async function resolveConfig(ctx: JobContext, name: string, dir: string): Promise<unknown> {
  const out = await processRunner.capture(
    [docker(), "compose", "-p", name, "config", "--format", "json"],
    { cwd: dir, signal: ctx.signal },
  );
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
 * Create the host folders the stack binds under the app data root, owned by $PUID:$PGID.
 *
 * Docker would create a missing bind source itself, but as root, and an image that drops
 * to $PUID then cannot write to its own config folder. Only folders under the data root are
 * created: anywhere else on the host is the user's business.
 */
async function prepareDataFolders(ctx: JobContext, resolved: unknown): Promise<void> {
  const root = config.appDataRoot;
  const services = (resolved as { services?: Record<string, { volumes?: unknown[] }> } | null)?.services ?? {};
  const sources = new Set<string>();
  for (const svc of Object.values(services)) {
    for (const v of svc?.volumes ?? []) {
      const vol = v as { type?: string; source?: string };
      if (vol.type === "bind" && vol.source && vol.source.startsWith(`${root}/`)) sources.add(vol.source);
    }
  }
  const { puid, pgid } = config.appIds;
  const asRoot = process.getuid?.() === 0;
  for (const source of sources) {
    if (await exists(source)) continue;
    // A source with a dot in its last part is most likely a file mount; Docker would make
    // it a folder, so leave it for the user to create.
    if (/\.[A-Za-z0-9]+$/.test(source)) continue;
    // The folders this creates: from the source up to the first one that already exists,
    // never above the data root. Only those change owner.
    const created: string[] = [];
    for (let dir = source; dir.startsWith(`${root}/`) && !(await exists(dir)); dir = dirname(dir)) created.push(dir);
    await mkdir(source, { recursive: true });
    if (asRoot) for (const dir of created) await chown(dir, puid, pgid).catch(() => {});
    ctx.log(`Created ${source}${asRoot ? ` (owner ${puid}:${pgid})` : ""}`);
  }
}

/**
 * Install or redeploy a stack: write its files, check them, record the stack, start it.
 *
 * Files are written before checking because Compose must read them from the stack folder
 * (relative paths and `env_file:` resolve there). A check that fails puts everything back:
 * an install removes the folder it created, a redeploy restores the previous files.
 */
export async function runDeploy(ctx: JobContext, mode: "install" | "redeploy", req: DeployRequest): Promise<void> {
  const dir = stackDir(req.name);
  const composePath = join(dir, COMPOSE_FILE);
  const envPath = join(dir, ".env");

  const previous = mode === "redeploy"
    ? { compose: await readIfExists(composePath), env: await readIfExists(envPath) }
    : null;
  const rollback = async () => {
    if (mode === "install") {
      await rm(dir, { recursive: true, force: true });
      ctx.log("Removed the files written for this install");
    } else if (previous) {
      if (previous.compose !== null) await Bun.write(composePath, previous.compose);
      if (previous.env !== null) await Bun.write(envPath, previous.env);
      else await rm(envPath, { force: true });
      ctx.log("Restored the previous compose and .env files");
    }
  };

  ctx.step("Writing files");
  await mkdir(dir, { recursive: true });
  const baseEnv = req.env ?? previous?.env ?? "";
  const { env, added } = withPlatformDefaults(baseEnv, req.compose, req.name);
  await Bun.write(composePath, req.compose);
  // An install with nothing to put in .env writes none; a redeploy that had one updates it.
  if (env || (previous && previous.env !== null)) await Bun.write(envPath, env);
  if (added.length > 0) ctx.log(`Added to .env: ${added.join(", ")}`);

  let resolved: unknown;
  try {
    ctx.step("Checking the compose file");
    resolved = await resolveConfig(ctx, req.name, dir);

    ctx.step("Checking ports");
    const conflicts = await findPortConflicts(publishedPorts(resolved), req.name);
    if (conflicts.length > 0) throw new JobError(`Port conflict: ${describeConflicts(conflicts)}`);
  } catch (err) {
    await rollback();
    throw err;
  }

  await prepareDataFolders(ctx, resolved);

  // The row is written before `up`, with managed set, so the stack is anpan-os's from the
  // moment its containers exist, whatever the home page's poll sees first.
  await StackStore.claim(req.name, req.meta ?? {});
  invalidateOriginCache(req.name);

  ctx.step("Starting containers");
  try {
    await composeUp(ctx, req.name, dir);
  } catch (err) {
    // A failed (or cancelled) install leaves nothing behind, so pressing Install again
    // works: otherwise the folder and row it made would answer "already exists", and the
    // user would have to find Delete for a stack that never started. A failed redeploy
    // keeps its new files, which are what the user is trying to make work.
    if (mode === "install") await undoInstall(ctx, req.name, dir);
    throw err;
  }
}

/**
 * Remove what a failed install created: any containers and networks it got as far as
 * making, the stack folder and the stack's row. Named volumes stay (`down` without -v).
 *
 * Runs even when the job was cancelled, so it does not use the job's own signal. It has a
 * time limit of its own instead: a Docker that hangs must not keep the job running forever.
 */
async function undoInstall(ctx: JobContext, name: string, dir: string): Promise<void> {
  ctx.log("Install failed: removing what it created");
  const signal = AbortSignal.timeout(2 * 60_000);
  await processRunner.run([docker(), "compose", "-p", name, "down", "--remove-orphans"], { cwd: dir, signal, onLine: line => ctx.log(line) })
    .catch(() => 1);
  await rm(dir, { recursive: true, force: true });
  await StackStore.delete(name);
  invalidateOriginCache(name);
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
  await ctx.exec([docker(), "compose", "pull"], dir, "docker compose pull");
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
  await mkdir(dir, { recursive: true });
  await Bun.write(join(dir, COMPOSE_FILE), raw);
  ctx.log(`Copied ${sourcePath} → ${join(dir, COMPOSE_FILE)}`);

  await StackStore.claim(name, meta);
  invalidateOriginCache(name);

  // --force-recreate is required: unchanged containers would otherwise keep the labels of
  // the CasaOS file they were created from, leaving the project split across two files.
  ctx.step("Recreating containers from the copy");
  await composeUp(ctx, name, dir, ["--remove-orphans", "--force-recreate"]);
}

/**
 * Re-anchor a stack on its managed compose file; see the repair route.
 *
 * When the managed file had to be adopted from another location and the orphan check then
 * refuses, the adopted copy is removed again, so a refused repair changes nothing.
 */
export async function runRepair(ctx: JobContext, name: string): Promise<void> {
  ctx.step("Reading compose sources");
  const report = await buildComposeSourceReport(name);
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
