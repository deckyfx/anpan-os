/**
 * Find ports a stack wants that something else already holds, before it is deployed.
 *
 * Without this, a clash shows up only as `docker compose up` failing halfway with "port is
 * already allocated", after some of the stack's containers have started and others have
 * not. Checked first, the install stops before anything starts and names who holds the port.
 */
import { ports as portProvider, type Listener } from "./providers/ports";
import { DockerClient } from "./docker";

/** One host port a service publishes. */
export interface PublishedPort {
  port:    number;
  proto:   "tcp" | "udp";
  /** Host address it binds; empty means every address. */
  hostIp:  string;
  service: string;
}

/** A published port already in use, and what holds it. */
export interface PortConflict {
  port:    number;
  proto:   "tcp" | "udp";
  service: string;
  /** e.g. `container "jellyfin" (stack media)` or `process sshd`. */
  heldBy:  string;
}

/** Most ports one range may expand to. A range wider than this is checked at its ends only. */
const MAX_RANGE = 1000;

/**
 * Published host ports from `docker compose config --format json` output.
 *
 * That output has every variable already substituted, so `${WEB_PORT:-8080}` arrives as
 * 8080. Services on the host network publish nothing through Docker and are skipped.
 */
export function publishedPorts(resolved: unknown): PublishedPort[] {
  const out: PublishedPort[] = [];
  const services = (resolved as { services?: Record<string, unknown> } | null)?.services ?? {};
  for (const [service, raw] of Object.entries(services)) {
    const svc = raw as { network_mode?: string; ports?: unknown[] } | null;
    if (!svc || svc.network_mode === "host" || !Array.isArray(svc.ports)) continue;
    for (const p of svc.ports) {
      const entry = p as { published?: string | number; protocol?: string; host_ip?: string };
      if (entry.published === undefined || entry.published === "") continue;
      const proto = entry.protocol === "udp" ? "udp" : "tcp";
      const hostIp = entry.host_ip ?? "";
      for (const port of expandRange(String(entry.published))) {
        out.push({ port, proto, hostIp, service });
      }
    }
  }
  return out;
}

function expandRange(spec: string): number[] {
  const [a, b] = spec.split("-").map(n => Number.parseInt(n, 10));
  if (a === undefined || !Number.isInteger(a)) return [];
  if (b === undefined || !Number.isInteger(b) || b < a) return [a];
  if (b - a > MAX_RANGE) return [a, b];
  return Array.from({ length: b - a + 1 }, (_, i) => a + i);
}

const WILDCARD = new Set(["", "*", "0.0.0.0", "::"]);

/** Two binds of one port clash unless they are on different specific addresses. */
function overlaps(a: string, b: string): boolean {
  // `ss` writes "[::1]" and "127.0.0.53%lo": brackets and an interface suffix are not part
  // of the address.
  const norm = (s: string) => s.replace(/%.*$/, "").replace(/^\[|\]$/g, "");
  return WILDCARD.has(norm(a)) || WILDCARD.has(norm(b)) || norm(a) === norm(b);
}

/**
 * The ports in `wanted` that something other than `project` already holds.
 *
 * Two sources:
 * - Running containers' published ports, which name the container and stack.
 * - Listening sockets (`ss` or `lsof`), which also catch services outside Docker.
 *
 * The project's own containers are left out, so redeploying a stack does not clash with
 * itself.
 */
export async function findPortConflicts(wanted: PublishedPort[], project: string): Promise<PortConflict[]> {
  if (wanted.length === 0) return [];

  const [listeners, containers] = await Promise.all([
    portProvider.listeners().catch((): Listener[] => []),
    DockerClient.listContainers(),
  ]);

  // Ports held by containers, by "port/proto". Docker's own proxy shows up among the
  // listening sockets too, so this map also tells those apart from foreign processes.
  const byContainer = new Map<string, { owner: string; project: string; ip: string }[]>();
  for (const c of containers.ok ? containers.data : []) {
    const owner = c.Labels["com.docker.compose.project"] ?? "";
    const name = (c.Names[0] ?? c.Id.slice(0, 12)).replace(/^\//, "");
    for (const p of c.Ports) {
      if (!p.PublicPort) continue;
      const key = `${p.PublicPort}/${p.Type === "udp" ? "udp" : "tcp"}`;
      const list = byContainer.get(key) ?? [];
      list.push({ owner: owner ? `container "${name}" (stack ${owner})` : `container "${name}"`, project: owner, ip: p.IP ?? "" });
      byContainer.set(key, list);
    }
  }

  const conflicts: PortConflict[] = [];
  const seen = new Set<string>();
  for (const want of wanted) {
    const key = `${want.port}/${want.proto}`;
    if (seen.has(key)) continue;

    const held = byContainer.get(key) ?? [];
    const foreignContainer = held.find(h => h.project !== project && overlaps(h.ip, want.hostIp));
    if (foreignContainer) {
      conflicts.push({ port: want.port, proto: want.proto, service: want.service, heldBy: foreignContainer.owner });
      seen.add(key);
      continue;
    }
    // A socket counts only when no container of any project explains it; this project's
    // own containers hold their ports legitimately.
    if (held.length > 0) continue;
    const socket = listeners.find(l => l.port === want.port && l.proto === want.proto && overlaps(l.address, want.hostIp));
    if (socket) {
      conflicts.push({
        port: want.port, proto: want.proto, service: want.service,
        heldBy: socket.process ? `process ${socket.process}${socket.pid ? ` (pid ${socket.pid})` : ""}` : "another program",
      });
      seen.add(key);
    }
  }
  return conflicts;
}

/** One line per conflict, for a job log or an error message. */
export function describeConflicts(conflicts: PortConflict[]): string {
  return conflicts
    .map(c => `port ${c.port}/${c.proto} (service ${c.service}) is already used by ${c.heldBy}`)
    .join("; ");
}
