/** Typed wrapper over the Docker HTTP API via Unix socket. */

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { DOCKER_SOCKET } from "./platform";

/**
 * Canonical form of a compose file path, for comparing our own paths against the
 * `com.docker.compose.project.config_files` label.
 *
 * Compose stores resolved absolute paths in that label, so a plain string compare against
 * a path we built with `join()` fails whenever the compose folder contains a symlink or a
 * non-canonical segment — reporting healthy stacks as drifted and forcing --force-recreate
 * on every deploy.
 *
 * realpath is best-effort on purpose: the paths we compare are frequently unresolvable —
 * a label may name a compose file that has since been deleted, and a root-owned parent
 * directory can deny traversal to a non-root process. Both throw, and in both cases the
 * lexical form is the best answer available, so we fall back to it rather than failing.
 */
export function normalizeComposePath(path: string): string {
  if (!path) return path;
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

export interface DockerPort {
  IP?: string;
  PrivatePort: number;
  PublicPort?: number;
  Type: string;
}

export interface DockerContainer {
  Id: string;
  Names: string[];
  Image: string;
  ImageID: string;
  Status: string;
  State: string;
  Ports: DockerPort[];
  Created: number;
  Labels: Record<string, string>;
}

/** One service (container) within a stack. */
export interface DockerService {
  id: string;
  service: string;
  image: string;
  state: string;
  ports: DockerPort[];
}

/** A compose project or standalone container shown as a single app tile. */
export interface DockerStack {
  name: string;
  services: DockerService[];
  /** "running" = all up, "stopped" = all down, "partial" = mixed. */
  state: "running" | "partial" | "stopped";
  /** Icon URL from the "icon" container label (set by CasaOS). */
  icon?: string;
}

export interface DockerContainerInspect {
  Id: string;
  Name: string;
  State: {
    Status: string;
    Running: boolean;
    Paused: boolean;
    Restarting: boolean;
    ExitCode: number;
    StartedAt: string;
    FinishedAt: string;
  };
  Config: {
    Image: string;
    Hostname: string;
    Env: string[] | null;
    Labels: Record<string, string> | null;
  };
  HostConfig: {
    RestartPolicy: { Name: string; MaximumRetryCount: number };
    NetworkMode: string;
    Binds: string[] | null;
  };
  Mounts: Array<{
    Type: string;
    Source: string;
    Destination: string;
    Mode: string;
    RW: boolean;
  }>;
  NetworkSettings: {
    Networks: Record<string, { IPAddress: string; Gateway: string; MacAddress: string }>;
    Ports: Record<string, Array<{ HostIp: string; HostPort: string }> | null>;
  };
}

export interface DockerInfo {
  Containers: number;
  ContainersRunning: number;
  ContainersPaused: number;
  ContainersStopped: number;
  Images: number;
  /** Logical CPUs visible to the daemon. */
  NCPU: number;
  /** Total host memory in bytes. */
  MemTotal: number;
  ServerVersion: string;
  OperatingSystem: string;
}

/** Host-wide totals for the dashboard summary bar. */
export interface DockerSummary {
  stacks: number;
  containers: { total: number; running: number; stopped: number; paused: number };
  /** Only containers declaring a HEALTHCHECK report health, so these do not sum to `total`. */
  health: { healthy: number; unhealthy: number; starting: number };
  volumes: number;
  /**
   * Images split by what they are, not one aggregate.
   *
   * A single number cannot be reconciled against anything: /info counts records including
   * intermediate layers, `docker images` hides untagged-but-digest-referenced entries, and
   * `docker system df` counts a third thing. Reporting the split says which of them the
   * viewer is looking at, and is the same breakdown the cleanup panel acts on.
   */
  images: {
    /**
     * False when the image list could not be read and `total` came from /info instead.
     *
     * The two count different things — /info includes intermediate layers — so a consumer
     * that renders them identically would show an inflated number with no sign that the
     * data is degraded.
     */
    classified: boolean;
    total: number;
    /** Referenced by a container, running or stopped — needed to start it again. */
    active: number;
    /** No repository tags: leftovers from a rebuild or retag. Safe to reclaim. */
    dangling: number;
    /** Tagged but unreferenced. Reclaimable, at the cost of pulling it again. */
    unused: number;
  };
  cpus: number;
  memTotal: number;
}

type DockerResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

/**
 * Where the daemon listens.
 *
 * Not a constant path any more: Docker Desktop, OrbStack, Colima and Rancher Desktop
 * each put the socket somewhere under the user's home on macOS, and only Docker
 * Desktop reliably links /var/run/docker.sock to it. See lib/platform.
 */
const SOCKET = DOCKER_SOCKET;
const BASE   = "http://localhost";

async function dockerFetch<T>(
  path: string,
  init?: RequestInit,
): Promise<DockerResult<T>> {
  try {
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      unix: SOCKET,
    } as RequestInit);
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      return { ok: false, error: `Docker API ${res.status}: ${text}` };
    }
    const data = await res.json() as T;
    return { ok: true, data };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Docker socket unavailable: ${msg}` };
  }
}

async function dockerAction(path: string, method = "POST"): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      unix: SOCKET,
    } as RequestInit);
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      return { ok: false, error: `Docker API ${res.status}: ${text}` };
    }
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Docker socket unavailable: ${msg}` };
  }
}

export class DockerClient {
  /** List all containers including stopped ones. */
  static listContainers(): Promise<DockerResult<DockerContainer[]>> {
    return dockerFetch<DockerContainer[]>("/containers/json?all=1");
  }

  /**
   * Group containers into stacks by their compose project label.
   * Standalone containers (no label) each become their own single-service stack.
   */
  static async listStacks(): Promise<DockerResult<DockerStack[]>> {
    const result = await dockerFetch<DockerContainer[]>("/containers/json?all=1");
    if (!result.ok) return result;

    const groups = new Map<string, { name: string; services: DockerService[]; rawContainers: DockerContainer[] }>();

    for (const c of result.data) {
      const project     = c.Labels?.["com.docker.compose.project"];
      const serviceName = c.Labels?.["com.docker.compose.service"]
        ?? c.Names[0]?.replace(/^\//, "")
        ?? c.Id.slice(0, 12);

      const groupKey  = project ?? c.Id;
      const groupName = project ?? serviceName;

      if (!groups.has(groupKey)) groups.set(groupKey, { name: groupName, services: [], rawContainers: [] });
      const group = groups.get(groupKey)!;
      group.services.push({
        id:      c.Id,
        service: serviceName,
        image:   c.Image,
        state:   c.State,
        ports:   c.Ports,
      });
      group.rawContainers.push(c);
    }

    const stacks: DockerStack[] = Array.from(groups.values()).map(({ name, services, rawContainers }) => {
      const allRunning = services.every((s) => s.state === "running");
      const allStopped = services.every((s) => s.state !== "running");
      const icon = rawContainers.find(c => c.Labels?.["icon"])?.Labels?.["icon"];
      return { name, services, state: allRunning ? "running" : allStopped ? "stopped" : "partial", ...(icon ? { icon } : {}) };
    });

    return { ok: true, data: stacks };
  }

  /** Inspect a single container. */
  static inspectContainer(id: string): Promise<DockerResult<DockerContainerInspect>> {
    return dockerFetch<DockerContainerInspect>(`/containers/${id}/json`);
  }

  /** Start a stopped container. */
  static startContainer(id: string) {
    return dockerAction(`/containers/${id}/start`);
  }

  /** Stop a running container. */
  static stopContainer(id: string) {
    return dockerAction(`/containers/${id}/stop`);
  }

  /** Restart a container. */
  static restartContainer(id: string) {
    return dockerAction(`/containers/${id}/restart`);
  }

  /** Fetch the last N log lines (stdout + stderr). Returns raw text. */
  static async getLogs(id: string, tail = 100): Promise<DockerResult<string>> {
    try {
      const res = await fetch(
        `${BASE}/containers/${id}/logs?stdout=1&stderr=1&tail=${tail}`,
        { unix: SOCKET } as RequestInit,
      );
      if (!res.ok) {
        const text = await res.text().catch(() => res.statusText);
        return { ok: false, error: `Docker API ${res.status}: ${text}` };
      }
      // Docker log stream prefixes each line with an 8-byte header — strip it
      const buf = await res.arrayBuffer();
      const raw = stripDockerLogHeaders(new Uint8Array(buf));
      return { ok: true, data: raw };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `Docker socket unavailable: ${msg}` };
    }
  }

  /** Get Docker daemon info. */
  static getInfo(): Promise<DockerResult<DockerInfo>> {
    return dockerFetch<DockerInfo>("/info");
  }

  /**
   * Host-wide totals for the dashboard summary bar.
   *
   * Three daemon calls, run concurrently: the container list (which alone yields stack
   * count, container states and health), `/info` for images/CPU/memory, and the volume
   * list. Container states come from the list rather than `/info` so every number in the
   * bar describes the same instant — `/info` counters are maintained separately and can
   * disagree with the list mid-transition.
   *
   * A failure of `/volumes` or `/info` degrades to zero for those fields instead of
   * failing the whole summary: a partially populated bar beats an empty one.
   */
  static async getSummary(): Promise<DockerResult<DockerSummary>> {
    const [listResult, infoResult, volumesResult, imagesResult] = await Promise.all([
      dockerFetch<DockerContainer[]>("/containers/json?all=1"),
      DockerClient.getInfo(),
      dockerFetch<{ Volumes: Array<unknown> | null }>("/volumes"),
      // /info's Images counts image records, not distinct images, and reads far higher
      // than any figure a user recognises — 192 on a host where `docker images` shows 132
      // rows over 111 unique IDs. Counting distinct Ids here gives the number people mean.
      dockerFetch<Array<{ Id: string; RepoTags: string[] | null }>>("/images/json"),
    ]);

    if (!listResult.ok) return listResult;

    // Classify images against the containers that reference them. Distinct Ids, since one
    // image tagged from two repositories appears twice but is one image on disk.
    const referenced = new Set(listResult.data.map(c => c.ImageID).filter(Boolean));
    const imageBreakdown = { classified: false, total: 0, active: 0, dangling: 0, unused: 0 };
    if (imagesResult.ok) {
      imageBreakdown.classified = true;
      const seen = new Set<string>();
      for (const img of imagesResult.data) {
        if (seen.has(img.Id)) continue;
        seen.add(img.Id);
        imageBreakdown.total++;
        if (referenced.has(img.Id))                             imageBreakdown.active++;
        else if (!img.RepoTags || img.RepoTags.length === 0
                 || img.RepoTags[0] === "<none>:<none>")        imageBreakdown.dangling++;
        else                                                    imageBreakdown.unused++;
      }
    } else if (infoResult.ok) {
      // Without the list there is nothing to classify. /info's figure is a different
      // measure, so it is reported with classified:false and the split left at zero —
      // the consumer decides how to present a number it cannot break down.
      imageBreakdown.total = infoResult.data.Images;
    }

    const projects = new Set<string>();
    const containers = { total: 0, running: 0, stopped: 0, paused: 0 };
    const health = { healthy: 0, unhealthy: 0, starting: 0 };

    for (const c of listResult.data) {
      containers.total++;

      // Docker reports many states; "running" and "paused" are distinct, and everything
      // else (exited, created, restarting, dead, removing) reads as not running.
      if (c.State === "running")     containers.running++;
      else if (c.State === "paused") containers.paused++;
      else                           containers.stopped++;

      const project = c.Labels?.["com.docker.compose.project"];
      if (project) projects.add(project);

      // Health rides along in the human-readable status, e.g. "Up 3 hours (healthy)".
      // There is no dedicated field on the list endpoint; only /containers/{id}/json has
      // one, and that would mean a request per container.
      if (c.Status?.includes("(healthy)"))             health.healthy++;
      else if (c.Status?.includes("(unhealthy)"))      health.unhealthy++;
      else if (c.Status?.includes("(health: starting)")) health.starting++;
    }

    return {
      ok: true,
      data: {
        stacks: projects.size,
        containers,
        health,
        volumes: volumesResult.ok ? (volumesResult.data.Volumes?.length ?? 0) : 0,
        images: imageBreakdown,
        cpus:    infoResult.ok ? infoResult.data.NCPU     : 0,
        memTotal:infoResult.ok ? infoResult.data.MemTotal : 0,
      },
    };
  }

  /** List all containers (including stopped) that belong to a compose project. */
  /**
   * Containers belonging to a stack, by the same rule that listed it.
   *
   * A "stack" is either a compose project or a single standalone container — listStacks()
   * groups by the compose label where there is one and by container Id where there is not,
   * naming the latter after the container itself. Resolving only the compose case here
   * meant those standalone entries matched nothing: deleting one removed zero containers
   * and reported success, so a container without a compose label could be shown in the UI
   * and never removed through it.
   *
   * The name fallback is restricted to containers with no compose project. A container
   * that belongs to a project must only be reachable through that project, or deleting by
   * container name could quietly take out one service of a running stack.
   */
  static async listProjectContainers(projectName: string): Promise<DockerResult<DockerContainer[]>> {
    // Fetch all and filter client-side — same pattern as listStacks().
    // Docker's server-side label filter syntax is unreliable over the Unix socket.
    const result = await dockerFetch<DockerContainer[]>("/containers/json?all=1");
    if (!result.ok) return result;

    const byProject = result.data.filter(c => c.Labels?.["com.docker.compose.project"] === projectName);
    if (byProject.length > 0) return { ok: true, data: byProject };

    const standalone = result.data.filter(c =>
      c.Labels?.["com.docker.compose.project"] === undefined &&
      c.Names.some(n => n.replace(/^\//, "") === projectName),
    );
    return { ok: true, data: standalone };
  }

  /**
   * Report which compose file each container of a project was created from.
   *
   * Compose stamps `com.docker.compose.project.config_files` onto every container it
   * creates. Because `up -d` only recreates containers whose service definition changed,
   * containers left untouched keep the label of whichever compose file created them —
   * so a project can end up with containers pointing at several different files.
   */
  static async listProjectComposeSources(
    projectName: string,
  ): Promise<DockerResult<Array<{ container: string; configFiles: string[]; workingDir: string }>>> {
    const result = await DockerClient.listProjectContainers(projectName);
    if (!result.ok) return result;
    return {
      ok: true,
      data: result.data.map(c => ({
        container: c.Names[0]?.replace(/^\//, "") ?? c.Id.slice(0, 12),
        configFiles: (c.Labels?.["com.docker.compose.project.config_files"] ?? "")
          .split(",")
          .map(s => s.trim())
          .filter(Boolean),
        workingDir: c.Labels?.["com.docker.compose.project.working_dir"] ?? "",
      })),
    };
  }

  /**
   * True when any container of the project was created from a compose file other than
   * `expectedComposePath`. Such containers keep stale labels — often pointing at a file
   * that no longer exists — until they are recreated.
   *
   * Returns false when the project has no containers, or when Docker is unreachable:
   * callers treat drift detection as an optimisation, never as a gate.
   */
  static async hasComposeDrift(projectName: string, expectedComposePath: string): Promise<boolean> {
    const result = await DockerClient.listProjectComposeSources(projectName);
    if (!result.ok) return false;
    const expected = normalizeComposePath(expectedComposePath);
    return result.data.some(
      c => c.configFiles.length > 0
        && !c.configFiles.map(normalizeComposePath).includes(expected),
    );
  }

  /**
   * Digest the local copy of an image was pulled with, e.g. "sha256:abc…".
   *
   * This is the *index* digest recorded in RepoDigests — the same thing a registry reports
   * for a tag — which is what makes the comparison meaningful. Returns null for images
   * built locally, which have no RepoDigests and therefore nothing to compare against.
   */
  static async getLocalDigest(image: string): Promise<string | null> {
    const result = await dockerFetch<{ RepoDigests?: string[] | null }>(
      `/images/${encodeURIComponent(image)}/json`,
    );
    if (!result.ok) return null;
    const digests = result.data.RepoDigests ?? [];
    if (digests.length === 0) return null;

    // An image tagged from more than one repository — an upstream and a mirror, say —
    // has several entries. Taking the first would compare a digest from one repository
    // against the registry answer for another, reporting an update that does not exist.
    const repository = image.split("@")[0]?.replace(/:[^:/]+$/, "") ?? image;
    const match = digests.find(d => d.split("@")[0] === repository) ?? digests[0];
    if (!match) return null;

    const at = match.indexOf("@");
    return at >= 0 ? match.slice(at + 1) : null;
  }

  /** Force-remove a container (stops it first if running). `v=1` removes anonymous volumes. */
  static removeContainer(id: string): Promise<{ ok: boolean; error?: string }> {
    return dockerAction(`/containers/${id}?force=true&v=1`, "DELETE");
  }

  /** List named volumes belonging to a compose project. */
  static async listProjectVolumes(projectName: string): Promise<DockerResult<{ Volumes: Array<{ Name: string }> | null }>> {
    const result = await dockerFetch<{ Volumes: Array<{ Name: string; Labels: Record<string, string> | null }> | null }>("/volumes");
    if (!result.ok) return result;
    return {
      ok: true,
      data: {
        Volumes: (result.data.Volumes ?? []).filter(
          v => v.Labels?.["com.docker.compose.project"] === projectName,
        ),
      },
    };
  }

  /** Remove a named volume. */
  static removeVolume(name: string): Promise<{ ok: boolean; error?: string }> {
    return dockerAction(`/volumes/${encodeURIComponent(name)}`, "DELETE");
  }

  /** List networks belonging to a compose project. */
  static async listProjectNetworks(projectName: string): Promise<DockerResult<Array<{ Id: string; Name: string }>>> {
    const result = await dockerFetch<Array<{ Id: string; Name: string; Labels: Record<string, string> | null }>>("/networks");
    if (!result.ok) return result;
    return {
      ok: true,
      data: result.data.filter(n => n.Labels?.["com.docker.compose.project"] === projectName),
    };
  }

  /** Remove a network. */
  static removeNetwork(id: string): Promise<{ ok: boolean; error?: string }> {
    return dockerAction(`/networks/${id}`, "DELETE");
  }
}

/** Strip Docker multiplexed stream headers (8 bytes per frame). */
function stripDockerLogHeaders(buf: Uint8Array): string {
  const lines: string[] = [];
  let i = 0;
  const decoder = new TextDecoder();
  while (i < buf.length) {
    if (i + 8 > buf.length) break;
    // bytes 4-7 = big-endian uint32 payload size
    const size = (buf[4 + i]! << 24) | (buf[5 + i]! << 16) | (buf[6 + i]! << 8) | buf[7 + i]!;
    i += 8;
    if (size > 0 && i + size <= buf.length) {
      lines.push(decoder.decode(buf.slice(i, i + size)));
    }
    i += size;
  }
  return lines.join("").trimEnd();
}
