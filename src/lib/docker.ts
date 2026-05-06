/** Typed wrapper over the Docker HTTP API via Unix socket. */

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
  ServerVersion: string;
  OperatingSystem: string;
}

type DockerResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

const SOCKET = "/var/run/docker.sock";
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

  /** List all containers (including stopped) that belong to a compose project. */
  static async listProjectContainers(projectName: string): Promise<DockerResult<DockerContainer[]>> {
    // Fetch all and filter client-side — same pattern as listStacks().
    // Docker's server-side label filter syntax is unreliable over the Unix socket.
    const result = await dockerFetch<DockerContainer[]>("/containers/json?all=1");
    if (!result.ok) return result;
    return {
      ok: true,
      data: result.data.filter(c => c.Labels?.["com.docker.compose.project"] === projectName),
    };
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
