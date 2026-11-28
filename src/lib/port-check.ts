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
  /**
   * For `published: "8080-8082"` against one container port, the ports Compose may pick
   * from. The publish fails only when every one of them is taken. `port` is the first.
   */
  alternatives?: number[];
}

/** A published port already in use, and what holds it. */
export interface PortConflict {
  port:    number;
  proto:   "tcp" | "udp";
  service: string;
  /** e.g. `container "jellyfin" (stack media)` or `process sshd`. */
  heldBy:  string;
  /** Set when the request was a range and every port in it is taken. */
  range?:  string;
}

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
      const ports = expandRange(String(entry.published));
      if (ports.length === 0) continue;
      // One entry per container port: a published range here is a choice, not several binds.
      out.push(ports.length === 1
        ? { port: ports[0]!, proto, hostIp, service }
        : { port: ports[0]!, proto, hostIp, service, alternatives: ports });
    }
  }
  return out;
}

/**
 * Every port a published spec may use: `8080` is one, `5000-7000` is all 2001 of them.
 *
 * The whole interval, never a sample of it: Compose may take any free port inside, so the
 * range is exhausted only when every one is in use. Ports stop at 65535.
 */
function expandRange(spec: string): number[] {
  const [a, b] = spec.split("-").map(n => Number.parseInt(n, 10));
  if (a === undefined || !Number.isInteger(a)) return [];
  if (b === undefined || !Number.isInteger(b) || b < a) return [a];
  const last = Math.min(b, 65_535);
  return Array.from({ length: Math.max(1, last - a + 1) }, (_, i) => a + i);
}

/** An address as `ss`, `lsof` and Docker write it, without brackets or an interface suffix. */
function normalize(address: string): string {
  return address.replace(/%.*$/, "").replace(/^\[|\]$/g, "");
}

/**
 * Whether binds of one port on `a` and `b` clash.
 *
 * An empty address or `*` means every address, and `::` is taken as dual-stack (Linux's
 * default), so all of those clash with anything. `0.0.0.0` covers IPv4 only: it does not
 * clash with an explicit IPv6 address such as `::1`. Otherwise only the same address
 * clashes.
 */
export function overlaps(a: string, b: string): boolean {
  const x = normalize(a);
  const y = normalize(b);
  const every = (s: string) => s === "" || s === "*" || s === "::";
  if (every(x) || every(y)) return true;
  const v4 = (s: string) => !s.includes(":");
  if (x === "0.0.0.0") return v4(y);
  if (y === "0.0.0.0") return v4(x);
  return x === y;
}

interface Mapping { owner: string; project: string; ip: string }

/**
 * The ports in `wanted` that something other than `project` already holds.
 *
 * Two sources:
 * - Running containers' published ports, which name the container and stack.
 * - Listening sockets (`ss` or `lsof`), which also catch services outside Docker.
 *
 * Docker's own proxy shows up among the sockets too. A socket is put down to a container
 * only when a container maps that port on an overlapping address. So the project's own
 * containers never clash with a redeploy of it, while a host process on another address of
 * the same port is still caught.
 */
export async function findPortConflicts(wanted: PublishedPort[], project: string): Promise<PortConflict[]> {
  if (wanted.length === 0) return [];

  const [listeners, containers] = await Promise.all([
    portProvider.listeners().catch((): Listener[] => []),
    DockerClient.listContainers(),
  ]);

  const byContainer = new Map<string, Mapping[]>();
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

  /** What holds `port` on an address overlapping `hostIp`, or null when it is free. */
  const holderOf = (port: number, proto: "tcp" | "udp", hostIp: string): string | null => {
    const mappings = byContainer.get(`${port}/${proto}`) ?? [];
    const foreign = mappings.find(m => m.project !== project && overlaps(m.ip, hostIp));
    if (foreign) return foreign.owner;
    for (const l of listeners) {
      if (l.port !== port || l.proto !== proto || !overlaps(l.address, hostIp)) continue;
      // This socket is a container's mapping (Docker's proxy), already judged above.
      if (mappings.some(m => overlaps(m.ip, l.address))) continue;
      return l.process ? `process ${l.process}${l.pid ? ` (pid ${l.pid})` : ""}` : "another program";
    }
    return null;
  };

  const conflicts: PortConflict[] = [];
  const seen = new Set<string>();
  for (const want of wanted) {
    const candidates = want.alternatives ?? [want.port];
    const key = `${candidates[0]}-${candidates[candidates.length - 1]}/${want.proto}@${want.hostIp}`;
    if (seen.has(key)) continue;
    seen.add(key);

    // Exhausted only if no port in it is free; the first free one settles it.
    let firstHolder: string | null = null;
    let free = false;
    for (const port of candidates) {
      const holder = holderOf(port, want.proto, want.hostIp);
      if (holder === null) { free = true; break; }
      firstHolder ??= holder;
    }
    if (free) continue;
    conflicts.push({
      port: want.port, proto: want.proto, service: want.service, heldBy: firstHolder!,
      ...(want.alternatives ? { range: `${candidates[0]}-${candidates[candidates.length - 1]}` } : {}),
    });
  }
  return conflicts;
}

/** One line per conflict, for a job log or an error message. */
export function describeConflicts(conflicts: PortConflict[]): string {
  return conflicts
    .map(c => c.range
      ? `every port in ${c.range}/${c.proto} (service ${c.service}) is in use, ${c.port} by ${c.heldBy}`
      : `port ${c.port}/${c.proto} (service ${c.service}) is already used by ${c.heldBy}`)
    .join("; ");
}
