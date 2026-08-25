/**
 * `df` parsing, shared by both platforms.
 *
 * -P (POSIX output) is what makes this one parser instead of two: macOS `df -k` appends
 * inode columns, so the mount point lands in field 9 there and field 6 on Linux. Fixing the
 * format at six fields removed a silent misparse in which the `%iused` percentage was being
 * read as a path.
 */

import type { DiskMount } from "./types";

/** Parse `df -Pk` output. Sizes are 1024-byte blocks; the result is bytes. */
export function parseDf(raw: string): DiskMount[] {
  const rows: DiskMount[] = [];
  for (const line of raw.trim().split("\n").slice(1)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 6) continue;
    const device = parts[0]!;
    // Real block devices only — skips tmpfs, devfs, overlay, "map auto_home" and friends.
    if (!device.startsWith("/dev/")) continue;
    const total = parseInt(parts[1]!, 10) * 1024;
    const used  = parseInt(parts[2]!, 10) * 1024;
    if (!Number.isFinite(total) || total <= 0) continue;
    // Mount points can contain spaces ("/Volumes/My Disk"); -P puts the mount last.
    rows.push({ device, mount: parts.slice(5).join(" "), used, total });
  }
  return rows;
}

/** One entry per device. A device mounted twice is one disk, not two. */
export function dedupeByDevice(rows: DiskMount[]): DiskMount[] {
  const seen = new Set<string>();
  return rows.filter(d => !seen.has(d.device) && seen.add(d.device));
}
