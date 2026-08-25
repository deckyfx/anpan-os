/**
 * macOS metrics, from the kernel's tick counters, vm_stat and df.
 *
 * There is no /proc. node:os exposes the same per-core tick counters `top` derives its
 * figure from, and vm_stat breaks memory into the page classes Activity Monitor adds up.
 */

import { cpus, freemem, totalmem } from "node:os";
import { bins } from "../../commands";
import { parseDf } from "./df";
import { cpuUsageFrom } from "./linux";
import type { CpuSample, DiskMount, MetricsProvider, RamUsage } from "./types";

/** Sum per-core ticks into one machine-wide sample. */
export function sampleCpus(cores: ReturnType<typeof cpus>): CpuSample {
  let idle = 0, total = 0;
  for (const core of cores) {
    idle  += core.times.idle;
    total += core.times.user + core.times.nice + core.times.sys + core.times.idle + core.times.irq;
  }
  return { idle, total };
}

/**
 * Parse `vm_stat` into used bytes.
 *
 * `os.freemem()` is unusable here: macOS treats nearly all unallocated memory as file
 * cache, so a healthy machine reports a few hundred MB free and the gauge would sit at 95%
 * permanently. What Activity Monitor calls "memory used" is the pages genuinely spoken for
 * — wired, active, and compressed — which is what these three counters are.
 *
 * The page size is read rather than assumed: 16 KB on Apple Silicon, 4 KB on Intel.
 * Returns null when the output cannot be understood, so the caller can fall back rather
 * than report a confidently wrong number.
 */
export function parseVmStat(raw: string, ramTotal: number): RamUsage | null {
  const pageSize = parseInt(raw.match(/page size of (\d+) bytes/)?.[1] ?? "4096", 10);

  const pages = (label: string): number => {
    const m = raw.match(new RegExp(`^${label}:\\s+(\\d+)\\.?`, "m"));
    return m ? parseInt(m[1]!, 10) : 0;
  };

  const used = (pages("Pages wired down") + pages("Pages active") + pages("Pages occupied by compressor")) * pageSize;
  if (used <= 0) return null;
  return { ramUsed: Math.min(used, ramTotal), ramTotal };
}

/**
 * Mount points that describe the OS rather than the user's storage.
 *
 * /System/Volumes/* are the firmlinked pieces of the boot container; CoreSimulator mounts
 * are disk images Xcode attaches per simulator runtime. Real mounts, but not disks anyone
 * manages from a dashboard.
 */
export function isSystemMount(mount: string): boolean {
  if (mount === "/System/Volumes/Data") return false; // the user's actual data volume
  return mount.startsWith("/System/Volumes/")
      || mount.startsWith("/Library/Developer/CoreSimulator/")
      || mount.startsWith("/private/var/vm");
}

/**
 * Split an APFS device into its container and volume.
 *
 *   /dev/disk3s5   → { container: "disk3", volume: "disk3s5" }
 *   /dev/disk3s1s1 → { container: "disk3", volume: "disk3s1" }   (a snapshot of disk3s1)
 *
 * Stripping the snapshot suffix is what stops the boot volume being counted twice: macOS
 * mounts the sealed system snapshot at "/" and the volume it came from at
 * /System/Volumes/Update/mnt1, both reporting the same bytes.
 */
export function apfsParts(device: string): { container: string; volume: string } | null {
  const m = device.match(/^\/dev\/(disk\d+)(s\d+)(s\d+)?$/);
  return m ? { container: m[1]!, volume: `${m[1]}${m[2]}` } : null;
}

/**
 * Collapse APFS volumes into the containers that actually back them.
 *
 * Volumes in one container share a single pool of free space, so a stock Mac reports a
 * dozen rows for one 2 TB disk, each claiming the full 2 TB total and a slice of the usage.
 * Summing the distinct volumes against the shared total gives the figure Finder shows.
 */
export function groupApfs(rows: DiskMount[]): DiskMount[] {
  interface Container { total: number; used: number; volumes: Set<string>; mounts: string[] }
  const containers = new Map<string, Container>();
  const plain: DiskMount[] = [];

  for (const row of rows) {
    const parts = apfsParts(row.device);
    if (!parts) { plain.push(row); continue; }

    let c = containers.get(parts.container);
    if (!c) { c = { total: 0, used: 0, volumes: new Set(), mounts: [] }; containers.set(parts.container, c); }

    c.total = Math.max(c.total, row.total);
    c.mounts.push(row.mount);
    // Each volume contributes once, however many places it is mounted.
    if (!c.volumes.has(parts.volume)) { c.volumes.add(parts.volume); c.used += row.used; }
  }

  const disks: DiskMount[] = [];
  for (const [container, c] of containers) {
    // Prefer a mount a person would recognise: "/" is the boot disk, otherwise the
    // shortest path, which is the parent of any nested mount in the same container.
    const userMounts = c.mounts.filter(m => !isSystemMount(m));
    const mount = c.mounts.includes("/")
      ? "/"
      : [...(userMounts.length ? userMounts : c.mounts)].sort((a, b) => a.length - b.length)[0]!;

    // A container with nothing but system mounts is Apple's — recovery and simulator
    // containers, not a disk anyone manages.
    if (mount !== "/" && isSystemMount(mount)) continue;

    disks.push({ device: `/dev/${container}`, mount, used: c.used, total: c.total });
  }

  for (const row of plain) if (!isSystemMount(row.mount)) disks.push(row);
  return disks;
}

export class DarwinMetricsProvider implements MetricsProvider {
  readonly id = "darwin" as const;

  async cpu(): Promise<number> {
    const first = sampleCpus(cpus());
    await Bun.sleep(150);
    return cpuUsageFrom(first, sampleCpus(cpus()));
  }

  async ram(): Promise<RamUsage> {
    const ramTotal = totalmem();
    const res = await Bun.$`${bins.vm_stat ?? "vm_stat"}`.quiet().nothrow();
    if (res.exitCode !== 0) return { ramUsed: ramTotal - freemem(), ramTotal };
    return parseVmStat(res.stdout.toString(), ramTotal) ?? { ramUsed: ramTotal - freemem(), ramTotal };
  }

  async disks(): Promise<DiskMount[]> {
    const res = await Bun.$`${bins.df ?? "df"} -Pk`.quiet().nothrow();
    return groupApfs(parseDf(res.stdout.toString()));
  }
}
