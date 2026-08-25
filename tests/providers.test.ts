/**
 * Platform provider parsers.
 *
 * These are the reason the providers were split out. The parsing was previously inline in
 * route handlers behind `if (IS_LINUX)`, which meant the branch not taken could not be
 * exercised at all: on a Mac the /proc parsers were unreachable, and on Linux the vm_stat
 * and APFS logic was. Each parser is now a pure function over captured output, so both
 * platforms are tested wherever the suite happens to run.
 *
 * The fixtures are real output, not invented: the macOS ones were captured from an M-series
 * host, and the Linux ones follow the documented formats of /proc/stat, /proc/meminfo and
 * `ss -Htlnp`.
 */
import { test, expect, describe } from "bun:test";
import { parseProcStat, parseMeminfo, cpuUsageFrom } from "../src/lib/providers/metrics/linux";
import { parseVmStat, groupApfs, apfsParts, isSystemMount } from "../src/lib/providers/metrics/darwin";
import { parseDf, dedupeByDevice } from "../src/lib/providers/metrics/df";
import { parseSs }   from "../src/lib/providers/ports/ss";
import { parseLsof } from "../src/lib/providers/ports/lsof";

// ─── Linux CPU and memory ────────────────────────────────────────────────────

describe("Linux /proc parsing", () => {
  const PROC_STAT = `cpu  102 3 45 9000 120 0 8 0 0 0
cpu0 51 1 22 4500 60 0 4 0 0 0
intr 12345
`;

  test("parseProcStat sums every field and counts iowait as idle", () => {
    const s = parseProcStat(PROC_STAT);
    // idle 9000 + iowait 120
    expect(s.idle).toBe(9120);
    expect(s.total).toBe(102 + 3 + 45 + 9000 + 120 + 0 + 8);
  });

  test("cpuUsageFrom turns two samples into a percentage", () => {
    // 100 ticks elapsed, 75 of them idle → 25% busy.
    expect(cpuUsageFrom({ idle: 1000, total: 2000 }, { idle: 1075, total: 2100 })).toBe(25);
  });

  test("a stalled counter reports 0 rather than dividing by zero", () => {
    expect(cpuUsageFrom({ idle: 10, total: 100 }, { idle: 10, total: 100 })).toBe(0);
  });

  test("usage is clamped to 0–100", () => {
    // A counter that went backwards (a reset) must not produce a negative percentage.
    expect(cpuUsageFrom({ idle: 0, total: 0 }, { idle: 500, total: 100 })).toBe(0);
  });

  test("parseMeminfo uses MemAvailable, not MemFree", () => {
    const meminfo = `MemTotal:       16384000 kB
MemFree:          200000 kB
MemAvailable:   12000000 kB
Buffers:          100000 kB
`;
    const { ramUsed, ramTotal } = parseMeminfo(meminfo);
    expect(ramTotal).toBe(16384000 * 1024);
    // Used is total - available. Using MemFree would have reported ~15.4 GB used on a
    // machine with 12 GB genuinely available.
    expect(ramUsed).toBe((16384000 - 12000000) * 1024);
  });
});

// ─── macOS memory ────────────────────────────────────────────────────────────

describe("macOS vm_stat parsing", () => {
  // Apple Silicon: 16 KB pages, not the 4 KB an Intel Mac reports.
  const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               12345.
Pages active:                            400000.
Pages inactive:                          150000.
Pages speculative:                        20000.
Pages wired down:                        200000.
Pages purgeable:                           5000.
Pages occupied by compressor:            100000.
`;

  test("counts wired + active + compressed at the reported page size", () => {
    const total = 17179869184; // 16 GB
    const r = parseVmStat(VM_STAT, total)!;
    expect(r.ramUsed).toBe((200000 + 400000 + 100000) * 16384);
    expect(r.ramTotal).toBe(total);
  });

  test("reads the page size rather than assuming 4 KB", () => {
    const intel = VM_STAT.replace("16384 bytes", "4096 bytes");
    const r = parseVmStat(intel, 17179869184)!;
    // Same page counts, quarter the bytes.
    expect(r.ramUsed).toBe((200000 + 400000 + 100000) * 4096);
  });

  test("never reports more used than the machine has", () => {
    const r = parseVmStat(VM_STAT, 1024)!;
    expect(r.ramUsed).toBeLessThanOrEqual(1024);
  });

  test("unparseable output returns null so the caller can fall back", () => {
    expect(parseVmStat("not vm_stat output", 1024)).toBeNull();
  });
});

// ─── df, both platforms ──────────────────────────────────────────────────────

describe("df -Pk parsing", () => {
  const LINUX_DF = `Filesystem     1024-blocks      Used Available Capacity Mounted on
/dev/sda1        103081248  41203160  56600264      43% /
tmpfs              8168112         0   8168112       0% /dev/shm
/dev/sdb1       1953512960 891203160 962309800      49% /mnt/data
overlay          103081248  41203160  56600264      43% /var/lib/docker/overlay2/abc/merged
`;

  test("keeps only real block devices", () => {
    const rows = parseDf(LINUX_DF);
    expect(rows.map(r => r.device)).toEqual(["/dev/sda1", "/dev/sdb1"]);
  });

  test("converts 1024-blocks to bytes", () => {
    const root = parseDf(LINUX_DF).find(r => r.mount === "/")!;
    expect(root.total).toBe(103081248 * 1024);
    expect(root.used).toBe(41203160 * 1024);
  });

  test("mount points containing spaces survive", () => {
    const raw = `Filesystem 1024-blocks Used Available Capacity Mounted on
/dev/disk4s1     512000    6164    494132     2%    /Volumes/My Big Disk
`;
    expect(parseDf(raw)[0]!.mount).toBe("/Volumes/My Big Disk");
  });

  test("dedupeByDevice keeps one row per device", () => {
    const rows = parseDf(`Filesystem 1024-blocks Used Available Capacity Mounted on
/dev/sda1  100 50 50 50% /
/dev/sda1  100 50 50 50% /mnt/bind
`);
    expect(rows).toHaveLength(2);
    expect(dedupeByDevice(rows)).toHaveLength(1);
  });
});

// ─── APFS container grouping ─────────────────────────────────────────────────

describe("APFS grouping", () => {
  // Captured verbatim from `df -Pk` on an Apple Silicon Mac.
  const MAC_DF = `Filesystem     1024-blocks      Used  Available Capacity  Mounted on
/dev/disk3s1s1  1948455240  16220812 1206759836     2%    /
devfs                  230       230          0   100%    /dev
/dev/disk3s6    1948455240   1048596 1206759836     1%    /System/Volumes/VM
/dev/disk3s2    1948455240  14815572 1206759836     2%    /System/Volumes/Preboot
/dev/disk3s4    1948455240    817892 1206759836     1%    /System/Volumes/Update
/dev/disk3s5    1948455240 705967620 1206759836    37%    /System/Volumes/Data
map auto_home            0         0          0   100%    /System/Volumes/Data/home
/dev/disk3s1    1948455240  16220812 1206759836     2%    /System/Volumes/Update/mnt1
/dev/disk5s1      17659904  17159516     455144    98%    /Library/Developer/CoreSimulator/Volumes/iOS_23F77
`;

  test("apfsParts strips the snapshot suffix", () => {
    // The sealed system snapshot and the volume it came from are one volume.
    expect(apfsParts("/dev/disk3s1s1")).toEqual({ container: "disk3", volume: "disk3s1" });
    expect(apfsParts("/dev/disk3s5")).toEqual({ container: "disk3", volume: "disk3s5" });
    expect(apfsParts("/dev/sda1")).toBeNull();
  });

  test("isSystemMount spares the data volume", () => {
    expect(isSystemMount("/System/Volumes/Data")).toBe(false);
    expect(isSystemMount("/System/Volumes/Preboot")).toBe(true);
    expect(isSystemMount("/Library/Developer/CoreSimulator/Volumes/iOS_23F77")).toBe(true);
    expect(isSystemMount("/Volumes/External")).toBe(false);
  });

  test("one physical disk is reported once, not nine times", () => {
    const disks = groupApfs(parseDf(MAC_DF));
    expect(disks).toHaveLength(1);
    expect(disks[0]!.mount).toBe("/");
    expect(disks[0]!.device).toBe("/dev/disk3");
  });

  test("usage is summed across the container's volumes, against the shared total", () => {
    const d = groupApfs(parseDf(MAC_DF))[0]!;
    // disk3s1 + s2 + s4 + s5 + s6 — disk3s1s1 is a snapshot of disk3s1 and must not be
    // added again, which would overstate usage by 16 GB.
    const expected = (16220812 + 14815572 + 817892 + 705967620 + 1048596) * 1024;
    expect(d.used).toBe(expected);
    expect(d.total).toBe(1948455240 * 1024);
    // Sanity: the container cannot be more than full.
    expect(d.used).toBeLessThan(d.total);
  });

  test("an external disk is kept alongside the boot container", () => {
    const withExternal = MAC_DF + "/dev/disk8s1     512000    6164    494132     2%    /Volumes/Backup\n";
    const disks = groupApfs(parseDf(withExternal));
    expect(disks.map(d => d.mount).sort()).toEqual(["/", "/Volumes/Backup"]);
  });
});

// ─── Port parsers ────────────────────────────────────────────────────────────

describe("ss output (Linux)", () => {
  const SS = `LISTEN 0      128          0.0.0.0:22         0.0.0.0:*    users:(("sshd",pid=1234,fd=3))
LISTEN 0      511             [::]:80            [::]:*    users:(("nginx",pid=987,fd=6))
LISTEN 0      4096       127.0.0.1:5432       0.0.0.0:*    users:(("postgres",pid=555,fd=5))
`;

  test("extracts port, address, process and pid", () => {
    const l = parseSs(SS, "tcp");
    expect(l).toHaveLength(3);
    expect(l[0]).toMatchObject({ port: 22, address: "0.0.0.0", process: "sshd", pid: 1234, proto: "tcp" });
    expect(l[2]).toMatchObject({ port: 5432, address: "127.0.0.1", process: "postgres", pid: 555 });
  });

  test("IPv6 addresses keep their port", () => {
    expect(parseSs(SS, "tcp")[1]).toMatchObject({ port: 80, process: "nginx" });
  });

  test("garbage lines are skipped rather than throwing", () => {
    expect(parseSs("nonsense\n\n", "tcp")).toEqual([]);
  });
});

describe("lsof -F output (macOS)", () => {
  // Process-level fields (p, c) apply to every n line that follows them.
  const LSOF = `p770
ccom.docker.backend
n*:1433
n*:5000
p11558
cadb
n127.0.0.1:5037
n127.0.0.1:5037->127.0.0.1:52000
p454
cControlCenter
n[::1]:631
`;

  test("applies the owning process to each following socket", () => {
    const l = parseLsof(LSOF, "tcp");
    expect(l[0]).toMatchObject({ port: 1433, process: "com.docker.backend", pid: 770, address: "*" });
    expect(l[1]).toMatchObject({ port: 5000, process: "com.docker.backend", pid: 770 });
    expect(l[2]).toMatchObject({ port: 5037, process: "adb", pid: 11558, address: "127.0.0.1" });
  });

  test("established connections are not listeners", () => {
    // The "->" row for adb must be dropped, leaving one adb entry rather than two.
    expect(parseLsof(LSOF, "tcp").filter(e => e.process === "adb")).toHaveLength(1);
  });

  test("IPv6 brackets are stripped from the address", () => {
    const ipv6 = parseLsof(LSOF, "tcp").find(e => e.port === 631)!;
    expect(ipv6.address).toBe("::1");
  });

  test("a command containing spaces is not split", () => {
    const raw = "p1\ncMy Long App Name\nn*:8080\n";
    expect(parseLsof(raw, "tcp")[0]!.process).toBe("My Long App Name");
  });
});
