/**
 * Linux metrics, from /proc and df.
 *
 * The kernel publishes cumulative counters, so CPU usage does not exist as a readable
 * value — it is only ever the difference between two samples.
 */

import { bins } from "../../commands";
import { parseDf, dedupeByDevice } from "./df";
import type { CpuSample, DiskMount, MetricsProvider, RamUsage } from "./types";

/**
 * Parse the aggregate "cpu" line of /proc/stat.
 *
 * Fields after the label are jiffies per state: user, nice, system, idle, iowait, irq,
 * softirq, steal… Idle is idle + iowait, because a CPU waiting on disk is not doing work.
 */
export function parseProcStat(raw: string): CpuSample {
  const parts = raw.split("\n")[0]!.trim().split(/\s+/).slice(1).map(Number);
  const idle  = (parts[3] ?? 0) + (parts[4] ?? 0);
  const total = parts.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
  return { idle, total };
}

/**
 * Parse /proc/meminfo into used and total bytes.
 *
 * MemAvailable, not MemFree: free memory excludes reclaimable page cache, so a healthy
 * machine would report almost all of its RAM as used. MemAvailable is the kernel's own
 * estimate of what a new allocation could actually get.
 */
export function parseMeminfo(raw: string): RamUsage {
  const lines = raw.split("\n");
  const get = (key: string) => {
    const line = lines.find(l => l.startsWith(key));
    return line ? parseInt(line.split(/\s+/)[1]!, 10) * 1024 : 0;
  };
  const total = get("MemTotal:");
  const avail = get("MemAvailable:");
  return { ramUsed: Math.max(0, total - avail), ramTotal: total };
}

/** Turn two samples into a percentage. */
export function cpuUsageFrom(a: CpuSample, b: CpuSample): number {
  const deltaIdle  = b.idle  - a.idle;
  const deltaTotal = b.total - a.total;
  if (deltaTotal <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((1 - deltaIdle / deltaTotal) * 100)));
}

export class LinuxMetricsProvider implements MetricsProvider {
  readonly id = "linux" as const;

  private async sample(): Promise<CpuSample> {
    return parseProcStat(await Bun.file("/proc/stat").text());
  }

  async cpu(): Promise<number> {
    const first = await this.sample();
    await Bun.sleep(150);
    return cpuUsageFrom(first, await this.sample());
  }

  async ram(): Promise<RamUsage> {
    return parseMeminfo(await Bun.file("/proc/meminfo").text());
  }

  async disks(): Promise<DiskMount[]> {
    const res = await Bun.$`${bins.df ?? "df"} -Pk`.quiet().nothrow();
    return dedupeByDevice(parseDf(res.stdout.toString()));
  }
}
