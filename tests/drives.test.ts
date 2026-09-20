import { test, expect, describe } from "bun:test";
import {
  buildDrives, decodeLabel, isHiddenMount, isIgnoredDevice, isWithinRoot,
  type BlockDevice,
} from "../src/lib/drives";
import type { DiskMount } from "../src/lib/providers/metrics/types";

/**
 * The quick-access list is assembled from three sources that disagree with each other:
 * `df` knows usage but only for mounted filesystems, sysfs knows every partition but no
 * usage, and by-label knows names. The cases below are the ones where a naive merge
 * produces something wrong on screen — a partition listed twice, a mounted disk reported
 * as unmounted, or a drive offered for navigation the browser cannot reach.
 */

const noLabels = new Map<string, string>();

describe("isWithinRoot", () => {
  test("a sibling sharing a name prefix is not inside the root", () => {
    expect(isWithinRoot("/mnt/data-backup", "/mnt/data")).toBe(false);
    expect(isWithinRoot("/mnt/data/sub", "/mnt/data")).toBe(true);
    expect(isWithinRoot("/mnt/data", "/mnt/data")).toBe(true);
  });

  test("everything is inside the default root", () => {
    expect(isWithinRoot("/mnt/ssd02", "/")).toBe(true);
  });
});

test("isHiddenMount covers the EFI partition but not lookalikes", () => {
  expect(isHiddenMount("/boot")).toBe(true);
  expect(isHiddenMount("/boot/efi")).toBe(true);
  expect(isHiddenMount("/bootstrap")).toBe(false);
});

test("isIgnoredDevice skips pseudo-devices but keeps mdadm arrays", () => {
  // buildDrives never consults this, so the md case has to be asserted here or adding
  // "md" back to the ignore list would pass every other test in this file.
  expect(isIgnoredDevice("loop3")).toBe(true);
  expect(isIgnoredDevice("zram0")).toBe(true);
  expect(isIgnoredDevice("md0")).toBe(false);
  expect(isIgnoredDevice("nvme0n1")).toBe(false);
});

test("decodeLabel turns by-label escapes back into characters", () => {
  expect(decodeLabel("My\\x20Drive")).toBe("My Drive");
});

describe("buildDrives", () => {
  const blocks: BlockDevice[] = [
    { name: "nvme0n1",   total: 2_000_000_000_000, removable: false, parent: null      },
    { name: "nvme0n1p1", total: 1_000_000_000,     removable: false, parent: "nvme0n1" },
    { name: "nvme0n1p2", total: 1_999_000_000_000, removable: false, parent: "nvme0n1" },
    { name: "sda",       total: 32_000_000_000,    removable: true,  parent: null      },
  ];

  test("a device hidden by its mount point is not resurrected as unmounted", () => {
    // The EFI partition IS mounted, at /boot/efi. Withholding it from the df pass and then
    // letting the sysfs pass re-add it would both list it after we chose not to, and label
    // a mounted partition "Not mounted".
    const df: DiskMount[] = [
      { device: "/dev/nvme0n1p2", mount: "/",         used: 1, total: 2 },
      { device: "/dev/nvme0n1p1", mount: "/boot/efi", used: 1, total: 2 },
    ];
    const drives = buildDrives(df, blocks, noLabels, "/");
    expect(drives.map(d => d.device)).not.toContain("/dev/nvme0n1p1");
  });

  test("an unmounted partition is listed, and says why it cannot be opened", () => {
    const drives = buildDrives([], blocks, noLabels, "/");
    const usb = drives.find(d => d.device === "/dev/sda");
    expect(usb).toBeDefined();
    expect(usb!.mount).toBeNull();
    expect(usb!.used).toBeNull();
    expect(usb!.browsable).toBe(false);
    expect(usb!.unavailable).toBe("Not mounted");
    expect(usb!.removable).toBe(true);
  });

  test("a whole disk is not listed beside the partitions it contains", () => {
    const drives = buildDrives([], blocks, noLabels, "/");
    expect(drives.map(d => d.device)).not.toContain("/dev/nvme0n1");
    expect(drives.map(d => d.device)).toContain("/dev/nvme0n1p2");
  });

  test("a disk is not hidden by an unrelated device whose name extends its own", () => {
    // nvme0n10 is the tenth namespace on the controller, not a partition of nvme0n1 --
    // and sdaa is the 27th SCSI disk, not a partition of sda. Deciding by name prefix
    // makes each of these swallow a real disk.
    const lookalikes: BlockDevice[] = [
      { name: "nvme0n1",  total: 1_000, removable: false, parent: null },
      { name: "nvme0n10", total: 2_000, removable: false, parent: null },
      { name: "sda",      total: 3_000, removable: false, parent: null },
      { name: "sdaa",     total: 4_000, removable: false, parent: null },
    ];
    const devices = buildDrives([], lookalikes, noLabels, "/").map(d => d.device);
    expect(devices).toEqual(
      expect.arrayContaining(["/dev/nvme0n1", "/dev/nvme0n10", "/dev/sda", "/dev/sdaa"]),
    );
  });

  test("an assembled mdadm array is offered like any other volume", () => {
    // On a home server the RAID array is often the largest volume present, and is exactly
    // the "second disk" this panel exists to reach.
    const df: DiskMount[] = [{ device: "/dev/md0", mount: "/mnt/raid", used: 1, total: 2 }];
    const drives = buildDrives(df, [{ name: "md0", total: 8_000, removable: false, parent: null }],
      noLabels, "/");
    expect(drives.find(d => d.device === "/dev/md0")?.browsable).toBe(true);
  });

  test("a mount outside the browsable root is shown but refused, with the reason", () => {
    const df: DiskMount[] = [{ device: "/dev/nvme1n1", mount: "/mnt/ssd02", used: 1, total: 2 }];
    const drives = buildDrives(df, [], noLabels, "/DATA");
    expect(drives[0]!.browsable).toBe(false);
    expect(drives[0]!.unavailable).toContain("/DATA");
  });

  test("a device mounted twice is listed once, at its shallowest mount", () => {
    const df: DiskMount[] = [
      { device: "/dev/sdb1", mount: "/mnt/data/sub/deep", used: 1, total: 2 },
      { device: "/dev/sdb1", mount: "/mnt/data",          used: 1, total: 2 },
    ];
    const drives = buildDrives(df, [], noLabels, "/");
    expect(drives).toHaveLength(1);
    expect(drives[0]!.mount).toBe("/mnt/data");
  });

  test("labels and usage come through, and root sorts first", () => {
    const labels = new Map([["/dev/nvme1n1", "Team4TB02"]]);
    const df: DiskMount[] = [
      { device: "/dev/nvme1n1",   mount: "/mnt/ssd02", used: 75, total: 100 },
      { device: "/dev/nvme0n1p2", mount: "/",          used: 41, total: 100 },
    ];
    const drives = buildDrives(df, blocks, labels, "/");
    expect(drives[0]!.mount).toBe("/");                 // root first
    expect(drives[1]!.label).toBe("Team4TB02");
    expect(drives[1]!.used).toBe(75);
    expect(drives[1]!.browsable).toBe(true);
  });

  test("removable media sorts after fixed disks", () => {
    const df: DiskMount[] = [
      { device: "/dev/sda",       mount: "/media/usb0", used: 1, total: 2 },
      { device: "/dev/nvme0n1p2", mount: "/mnt/ssd01",  used: 1, total: 2 },
    ];
    const drives = buildDrives(df, blocks, noLabels, "/");
    // Scoped to the mounted ones: `blocks` also carries an unmounted partition, which
    // sorts last by design and is asserted separately above.
    expect(drives.filter(d => d.mount !== null).map(d => d.mount))
      .toEqual(["/mnt/ssd01", "/media/usb0"]);
    expect(drives.at(-1)!.mount).toBeNull();
  });
});
