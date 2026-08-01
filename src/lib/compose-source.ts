/**
 * Compose source tracking — which compose file each container was actually created from.
 *
 * Docker Compose stamps `com.docker.compose.project.config_files` and
 * `com.docker.compose.project.working_dir` onto every container it creates. Those labels
 * are written at creation time and never updated afterwards, which makes them the ground
 * truth for "where did this container come from" — and the source of a subtle fault:
 *
 * `docker compose up -d` only recreates containers whose service definition changed.
 * Containers whose spec is byte-identical keep running untouched, and keep the labels of
 * whichever compose file created them. Move a stack to a new folder and redeploy, and the
 * unchanged services stay anchored to the old path. The project is then owned by two
 * compose files at once — visible as multiple CONFIG FILES entries in `docker compose ls`
 * — and once the old file is deleted those containers reference a path that is gone.
 *
 * The fix is `--force-recreate`, which rebuilds every container and rewrites its labels.
 */

import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { config } from "../config";
import { bins } from "./commands";
import { DockerClient } from "./docker";

/**
 * How a stack's containers relate to the managed compose file.
 *
 * - `ok`       — every container was created from the managed compose file.
 * - `drift`    — the managed file exists, but some containers still carry an older path.
 *                Left behind by `up -d`, which skips containers whose spec did not change.
 * - `mixed`    — no managed file, and containers disagree among themselves: the project is
 *                split across two or more compose files. Broken regardless of who owns it.
 * - `external` — no managed file and all containers agree on one other file. Not managed
 *                by anpan-os, which is a valid state rather than a fault.
 * - `unknown`  — no compose labels at all (standalone containers, or Docker unreachable).
 */
export type ComposeSourceStatus = "ok" | "drift" | "mixed" | "external" | "unknown";

/** Per-container view of which compose file a stack's containers were created from. */
export interface ComposeSourceReport {
  stack: string;
  status: ComposeSourceStatus;
  /** True for `drift` and `mixed` — the states {@link repairStack} can resolve. */
  needsRepair: boolean;
  /** The managed path every container of this stack should point at. */
  expected: string;
  /** Whether the managed compose file is actually present on disk. */
  expectedExists: boolean;
  containers: Array<{
    container: string;
    configFiles: string[];
    workingDir: string;
    /** Container was created from the managed compose file. */
    matches: boolean;
    /** Container points at a compose file that no longer exists on disk. */
    dangling: boolean;
  }>;
  /** Distinct non-managed compose paths still in use by this stack. */
  foreignPaths: string[];
}

/** Read a compose file, falling back to `sudo -n` for root-owned paths (CasaOS et al). */
export async function readComposeFile(path: string): Promise<string | null> {
  try {
    return await Bun.file(path).text();
  } catch { /* unreadable as this user — try sudo below */ }
  const result = await Bun.$`sudo -n cat ${path}`.quiet().nothrow();
  return result.exitCode === 0 ? result.stdout.toString() : null;
}

/** Existence check that tolerates root-owned parent directories. */
export async function composeFileExists(path: string): Promise<boolean> {
  if (await Bun.file(path).exists()) return true;
  const result = await Bun.$`sudo -n test -f ${path}`.quiet().nothrow();
  return result.exitCode === 0;
}

/** The managed compose path for a stack, under the configured compose folder. */
export function managedComposePath(name: string): string {
  return join(config.composeFolder, name, "docker-compose.yml");
}

/**
 * Compare every container of `name` against the managed compose path.
 *
 * A stack is healthy when all its containers carry the managed path; see
 * {@link ComposeSourceStatus} for how the other states arise.
 */
export async function buildComposeSourceReport(name: string): Promise<ComposeSourceReport> {
  const expected = managedComposePath(name);
  const result   = await DockerClient.listProjectComposeSources(name);
  const sources  = result.ok ? result.data : [];

  const containers = await Promise.all(
    sources.map(async s => {
      const matches  = s.configFiles.includes(expected);
      const dangling = s.configFiles.length > 0
        && !(await Promise.all(s.configFiles.map(composeFileExists))).some(Boolean);
      return { ...s, matches, dangling };
    }),
  );

  const labelled       = containers.filter(c => c.configFiles.length > 0);
  const distinctPaths  = new Set(labelled.flatMap(c => c.configFiles));
  const foreignPaths   = [...distinctPaths].filter(p => p !== expected);
  const expectedExists = await composeFileExists(expected);

  const status: ComposeSourceStatus =
    labelled.length === 0            ? "unknown"
    : labelled.every(c => c.matches) ? "ok"
    : expectedExists                 ? "drift"
    : distinctPaths.size > 1         ? "mixed"
    :                                  "external";

  return {
    stack: name,
    status,
    needsRepair: status === "drift" || status === "mixed",
    expected,
    expectedExists,
    containers,
    foreignPaths,
  };
}

/** Build a report for every compose project visible to Docker. */
export async function scanComposeSources(): Promise<ComposeSourceReport[]> {
  const result = await DockerClient.listStacks();
  if (!result.ok) return [];
  const names = result.data
    .map(s => s.name)
    .filter(n => /^[a-zA-Z0-9_-]+$/.test(n));
  return Promise.all(names.map(buildComposeSourceReport));
}

/**
 * Services that are running but absent from the managed compose file.
 *
 * Repair redeploys with `--remove-orphans`, which deletes any container in the project
 * that the compose file does not define. When a stack drifted because it was split across
 * several files, the managed copy may describe only part of it — so this must be checked
 * before repairing, or repair would silently destroy the services it does not know about.
 */
export async function findOrphanServices(
  report: ComposeSourceReport,
): Promise<{ ok: true; orphans: string[] } | { ok: false; error: string }> {
  const docker = bins.docker;
  if (!docker) return { ok: false, error: "Docker is not available on this system" };

  const stackDir = join(config.composeFolder, report.stack);
  const defined = await Bun.$`${docker} compose config --services`
    .cwd(stackDir)
    .nothrow()
    .quiet();

  if (defined.exitCode !== 0) {
    return { ok: false, error: `Cannot read managed compose file: ${defined.stderr.toString().trim()}` };
  }

  const definedServices = new Set(
    defined.stdout.toString().split("\n").map(s => s.trim()).filter(Boolean),
  );

  const containers = await DockerClient.listProjectContainers(report.stack);
  if (!containers.ok) return { ok: false, error: containers.error };

  const orphans = [
    ...new Set(
      containers.data
        .map(c => c.Labels?.["com.docker.compose.service"])
        .filter((s): s is string => Boolean(s) && !definedServices.has(s!)),
    ),
  ];

  return { ok: true, orphans };
}

/**
 * Copy an existing compose file into the managed folder when one is not there yet.
 *
 * Returns the donor path on success, `null` when the managed file already existed, or an
 * error when nothing readable could be adopted.
 */
export async function adoptComposeFile(
  report: ComposeSourceReport,
): Promise<{ ok: true; adoptedFrom: string | null } | { ok: false; error: string }> {
  if (report.expectedExists) return { ok: true, adoptedFrom: null };

  const donor = report.foreignPaths[0];
  if (!donor) return { ok: false, error: "No compose file found for this stack — nothing to adopt" };

  const content = await readComposeFile(donor);
  if (content === null) {
    return { ok: false, error: `Cannot read ${donor} — anpan-os may need to run as root` };
  }

  try {
    mkdirSync(join(config.composeFolder, report.stack), { recursive: true });
    await Bun.write(report.expected, content);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  return { ok: true, adoptedFrom: donor };
}
