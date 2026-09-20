/**
 * Enumerate the machine's drives and partitions for the file manager's quick-access list.
 *
 * `df` alone is not enough. It reports what is *mounted*, so a second disk or a thumbdrive
 * that nothing auto-mounted is simply absent — and on a headless server there is often no
 * auto-mounter, which would make the panel look empty exactly when the user went looking
 * for the drive they just plugged in. The block devices are therefore enumerated from
 * sysfs and merged with `df`, so an unmounted partition is still listed, marked as such.
 *
 * Nothing here shells out beyond the `df` the system page already runs: labels come from
 * /dev/disk/by-label and removability from sysfs, so no new external tool is required.
 */

import { readdir, readFile, readlink, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { bins } from "./commands";
import { config } from "../config";

/** A drive or partition offered in the quick-access list. */
export interface Drive {
  /** Block device path, e.g. `/dev/nvme0n1p2`. */
  device: string;
  /** Mount point, or null when the device is not mounted. */
  mount: string | null;
  /** Filesystem label, when one exists. */
  label: string | null;
  /** Total size in bytes. */
  total: number;
  /** Bytes used, or null when not mounted (df cannot report usage for an unmounted fs). */
  used: number | null;
  /** Removable media — a thumbdrive, SD card or external USB disk. */
  removable: boolean;
  /** Whether the file manager may navigate here: mounted, and inside `config.filesRoot`. */
  browsable: boolean;
  /** Reason it is not browsable, for the UI to show instead of a dead link. */
  unavailable: string | null;
}

/** A mounted filesystem as `df` reports it. */
export interface DfRow {
  device: string;
  mount: string;
  used: number;
  total: number;
}

/** A block device as sysfs describes it. */
export interface BlockDevice {
  /** Kernel name, e.g. `nvme0n1p2`. */
  name: string;
  /** Size in bytes. */
  total: number;
  removable: boolean;
}

/**
 * Pseudo-devices that are never user-facing storage. `loop` backs snap packages (a host
 * with snaps has dozens), `ram`/`zram` are memory-backed, and `sr` is optical.
 */
const IGNORED_PREFIXES = ["loop", "ram", "zram", "sr", "fd", "md"];

/**
 * Mounts deliberately withheld from the list.
 *
 * The EFI system partition is not content — it holds the bootloader, it is tiny, and
 * offering it for browsing alongside the media disks invites someone to delete from it.
 */
const HIDDEN_MOUNT_PREFIXES = ["/boot"];

/** Parse `df -k` output into rows for real block devices, in bytes. */
export function parseDf(stdout: string): DfRow[] {
  const rows: DfRow[] = [];
  for (const line of stdout.trim().split("\n").slice(1)) {
    const parts = line.trim().split(/\s+/);
    // A mount point may contain spaces, so it is everything from field 6 onward rather
    // than field 6 alone -- splitting on whitespace would otherwise truncate "/mnt/my disk".
    if (parts.length < 6) continue;
    const device = parts[0]!;
    if (!device.startsWith("/dev/")) continue;
    const total = Number.parseInt(parts[1]!, 10) * 1024;
    const used = Number.parseInt(parts[2]!, 10) * 1024;
    const mount = parts.slice(5).join(" ");
    if (!Number.isFinite(total) || !Number.isFinite(used)) continue;
    rows.push({ device, mount, used, total });
  }
  return rows;
}

/** Whether a kernel device name is a pseudo-device we never show. */
export function isIgnoredDevice(name: string): boolean {
  return IGNORED_PREFIXES.some(p => name.startsWith(p));
}

/** Whether a mount point is one we deliberately withhold. */
export function isHiddenMount(mount: string): boolean {
  return HIDDEN_MOUNT_PREFIXES.some(p => mount === p || mount.startsWith(`${p}/`));
}

/**
 * Whether `path` sits inside `root`.
 *
 * Compared segment-wise rather than by string prefix, so `/mnt/data-backup` is not treated
 * as living inside `/mnt/data`.
 */
export function isWithinRoot(path: string, root: string): boolean {
  const r = resolve(root);
  const p = resolve(path);
  return r === "/" || p === r || p.startsWith(r.endsWith("/") ? r : `${r}/`);
}

/**
 * Enumerate block devices from sysfs, including partitions.
 *
 * Removability is read from the *parent* disk: a partition has no `removable` attribute of
 * its own, so asking the partition would report every thumbdrive partition as fixed. A USB
 * enclosure holding a conventional SSD reports `removable = 0`, so the sysfs device path is
 * also checked for a USB bus — otherwise an external drive sorts in with the internal ones.
 */
export async function listBlockDevices(sysBlock = "/sys/block"): Promise<BlockDevice[]> {
  const out: BlockDevice[] = [];
  let disks: string[];
  try {
    disks = await readdir(sysBlock);
  } catch {
    return out; // no sysfs (non-Linux): fall back to whatever df reported
  }

  for (const disk of disks) {
    if (isIgnoredDevice(disk)) continue;

    const removable = await isRemovable(sysBlock, disk);
    const diskSize = await readSectors(`${sysBlock}/${disk}/size`);
    if (diskSize > 0) out.push({ name: disk, total: diskSize, removable });

    // Partitions are subdirectories of the disk carrying their own `partition` file.
    let children: string[];
    try {
      children = await readdir(`${sysBlock}/${disk}`);
    } catch {
      continue;
    }
    for (const child of children) {
      if (!child.startsWith(disk)) continue;
      try {
        await stat(`${sysBlock}/${disk}/${child}/partition`);
      } catch {
        continue; // not a partition
      }
      const size = await readSectors(`${sysBlock}/${disk}/${child}/size`);
      if (size > 0) out.push({ name: child, total: size, removable });
    }
  }
  return out;
}

/** Read a sysfs `size` file, which counts 512-byte sectors regardless of the real block size. */
async function readSectors(path: string): Promise<number> {
  try {
    const sectors = Number.parseInt((await readFile(path, "utf8")).trim(), 10);
    return Number.isFinite(sectors) ? sectors * 512 : 0;
  } catch {
    return 0;
  }
}

/** Removable per sysfs, or attached over USB — either makes it external to the user. */
async function isRemovable(sysBlock: string, disk: string): Promise<boolean> {
  try {
    if ((await readFile(`${sysBlock}/${disk}/removable`, "utf8")).trim() === "1") return true;
  } catch { /* attribute missing — fall through to the bus check */ }
  try {
    const target = await readlink(`${sysBlock}/${disk}`);
    return /\/usb\d*\//.test(target);
  } catch {
    return false;
  }
}

/**
 * Map device path → filesystem label, from the by-label symlink farm.
 *
 * A label is what the user actually recognises ("Team4TB02"), where `/dev/nvme1n1` is not.
 */
export async function readLabels(byLabelDir = "/dev/disk/by-label"): Promise<Map<string, string>> {
  const labels = new Map<string, string>();
  let names: string[];
  try {
    names = await readdir(byLabelDir);
  } catch {
    return labels; // no labelled filesystems, or not Linux
  }
  for (const name of names) {
    try {
      const target = await readlink(`${byLabelDir}/${name}`);
      // Targets are relative, e.g. "../../nvme1n1".
      labels.set(`/dev/${basename(target)}`, decodeLabel(name));
    } catch { /* stale symlink */ }
  }
  return labels;
}

/** by-label names escape non-alphanumerics as \x20-style codes. */
export function decodeLabel(name: string): string {
  return name.replace(/\\x([0-9a-fA-F]{2})/g, (_, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)));
}

/**
 * Merge the three sources into the list the panel renders.
 *
 * Mounted devices come from `df` (it alone knows usage); unmounted ones are filled in from
 * sysfs so a drive that exists but is not mounted is visible rather than absent.
 */
export function buildDrives(
  df: DfRow[],
  blocks: BlockDevice[],
  labels: Map<string, string>,
  filesRoot: string,
): Drive[] {
  const byDevice = new Map<string, Drive>();
  const removableOf = new Map(blocks.map(b => [`/dev/${b.name}`, b.removable]));
  // Devices withheld because of *where* they are mounted. They must also be kept out of
  // the unmounted pass below, which would otherwise re-add the EFI partition as "Not
  // mounted" -- both listing it after we chose not to, and saying something untrue.
  const hidden = new Set(df.filter(r => isHiddenMount(r.mount)).map(r => r.device));

  for (const row of df) {
    if (isHiddenMount(row.mount)) continue;
    const within = isWithinRoot(row.mount, filesRoot);
    // The same device can be mounted more than once (bind mounts, subvolumes). Keep the
    // shallowest mount: it is the one that reaches the most content.
    const existing = byDevice.get(row.device);
    if (existing && existing.mount !== null && existing.mount.length <= row.mount.length) continue;
    byDevice.set(row.device, {
      device:      row.device,
      mount:       row.mount,
      label:       labels.get(row.device) ?? null,
      total:       row.total,
      used:        row.used,
      removable:   removableOf.get(row.device) ?? false,
      browsable:   within,
      unavailable: within ? null : `Outside the browsable root (${filesRoot})`,
    });
  }

  for (const block of blocks) {
    const device = `/dev/${block.name}`;
    if (byDevice.has(device) || hidden.has(device)) continue;
    // A whole disk that is merely the container for its partitions is not itself a place
    // to go. Listing it would put "nvme0n1" beside the partitions it holds.
    if (blocks.some(b => b.name !== block.name && b.name.startsWith(block.name))) continue;
    byDevice.set(device, {
      device,
      mount:       null,
      label:       labels.get(device) ?? null,
      total:       block.total,
      used:        null,
      removable:   block.removable,
      browsable:   false,
      unavailable: "Not mounted",
    });
  }

  return [...byDevice.values()].sort(compareDrives);
}

/** Root first, then fixed disks, then removable media; alphabetical within each group. */
function compareDrives(a: Drive, b: Drive): number {
  const rank = (d: Drive) => (d.mount === "/" ? 0 : d.mount === null ? 3 : d.removable ? 2 : 1);
  const diff = rank(a) - rank(b);
  if (diff !== 0) return diff;
  return (a.mount ?? a.device).localeCompare(b.mount ?? b.device);
}

/** Collect the current drive list. */
export async function listDrives(): Promise<Drive[]> {
  const [dfOut, blocks, labels] = await Promise.all([
    runDf(),
    listBlockDevices(),
    readLabels(),
  ]);
  return buildDrives(parseDf(dfOut), blocks, labels, config.filesRoot);
}

async function runDf(): Promise<string> {
  if (!bins.df) return "";
  const result = await Bun.$`${bins.df} -k`.quiet().nothrow();
  return result.stdout.toString();
}
