import { test, expect, describe } from "bun:test";
import {
  buildDrives, decodeLabel, isHiddenMount, isWithinRoot, parseDf,
  type BlockDevice, type DfRow,
} from "../src/lib/drives";

/**
 * The quick-access list is assembled from three sources that disagree with each other:
 * `df` knows usage but only for mounted filesystems, sysfs knows every partition but no
 * usage, and by-label knows names. The cases below are the ones where a naive merge
 * produces something wrong on screen — a partition listed twice, a mounted disk reported
 * as unmounted, or a drive offered for navigation the browser cannot reach.
 */

const noLabels = new Map<string, string>();

describe("parseDf", () => {
  test("reads real block devices and converts 1K blocks to bytes", () => {
    const rows = parseDf([
      "Filesystem     1K-blocks      Used Available Use% Mounted on",
      "/dev/nvme0n1p2   1966798   809721   1057096  44% /",
      "tmpfs              65536        0     65536   0% /run",
      "/dev/nvme1n1     3844572  2714180    935023  75% /mnt/ssd02",
    ].join("\n"));

    expect(rows).toHaveLength(2);                       // tmpfs dropped
    expect(rows[0]).toEqual({
      device: "/dev/nvme0n1p2", mount: "/", used: 809721 * 1024, total: 1966798 * 1024,
    });
  });

  test("keeps a mount point containing spaces intact", () => {
    // Splitting on whitespace and taking field 6 alone truncates this to "/mnt/my".
    const rows = parseDf([
      "Filesystem 1K-blocks Used Available Use% Mounted on",
      "/dev/sdb1 1000 500 500 50% /mnt/my backup disk",
    ].join("\n"));
    expect(rows[0]!.mount).toBe("/mnt/my backup disk");
  });
});

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

test("decodeLabel turns by-label escapes back into characters", () => {
  expect(decodeLabel("My\\x20Drive")).toBe("My Drive");
});

describe("buildDrives", () => {
  const blocks: BlockDevice[] = [
    { name: "nvme0n1",   total: 2_000_000_000_000, removable: false },
    { name: "nvme0n1p1", total: 1_000_000_000,     removable: false },
    { name: "nvme0n1p2", total: 1_999_000_000_000, removable: false },
    { name: "sda",       total: 32_000_000_000,    removable: true  },
  ];

  test("a device hidden by its mount point is not resurrected as unmounted", () => {
    // The EFI partition IS mounted, at /boot/efi. Withholding it from the df pass and then
    // letting the sysfs pass re-add it would both list it after we chose not to, and label
    // a mounted partition "Not mounted".
    const df: DfRow[] = [
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

  test("a mount outside the browsable root is shown but refused, with the reason", () => {
    const df: DfRow[] = [{ device: "/dev/nvme1n1", mount: "/mnt/ssd02", used: 1, total: 2 }];
    const drives = buildDrives(df, [], noLabels, "/DATA");
    expect(drives[0]!.browsable).toBe(false);
    expect(drives[0]!.unavailable).toContain("/DATA");
  });

  test("a device mounted twice is listed once, at its shallowest mount", () => {
    const df: DfRow[] = [
      { device: "/dev/sdb1", mount: "/mnt/data/sub/deep", used: 1, total: 2 },
      { device: "/dev/sdb1", mount: "/mnt/data",          used: 1, total: 2 },
    ];
    const drives = buildDrives(df, [], noLabels, "/");
    expect(drives).toHaveLength(1);
    expect(drives[0]!.mount).toBe("/mnt/data");
  });

  test("labels and usage come through, and root sorts first", () => {
    const labels = new Map([["/dev/nvme1n1", "Team4TB02"]]);
    const df: DfRow[] = [
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
    const df: DfRow[] = [
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
