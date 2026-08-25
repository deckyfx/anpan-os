/**
 * Metrics provider — CPU, memory and disk, however this OS reports them.
 *
 * The two platforms do not merely name things differently; they expose different data.
 * Linux publishes cumulative counters in /proc, macOS exposes per-core ticks through the
 * kernel and page counts through vm_stat, and the two disagree about what "used memory"
 * even means. Branching inside one function hid that, and made the branch not taken
 * impossible to test: a `/proc/stat` parser guarded by `IS_LINUX` cannot be exercised on a
 * Mac at all.
 *
 * Splitting parsing (pure, testable with fixture text) from collection (impure, reads the
 * host) is the point. Every implementation below keeps its parsers exported.
 */

export interface RamUsage {
  ramUsed:  number;
  ramTotal: number;
}

export interface DiskMount {
  device: string;
  mount:  string;
  used:   number;
  total:  number;
}

export interface MetricsProvider {
  readonly id: "linux" | "darwin";

  /** Whole-machine CPU usage, 0–100. Sampled over a short interval. */
  cpu(): Promise<number>;
  /** Memory in bytes. "Used" means what the platform's own tools call used. */
  ram(): Promise<RamUsage>;
  /** Physical disks, one entry per disk rather than per mount. */
  disks(): Promise<DiskMount[]>;
}

/** A point-in-time CPU reading. Usage is the delta between two of these. */
export interface CpuSample {
  idle:  number;
  total: number;
}
