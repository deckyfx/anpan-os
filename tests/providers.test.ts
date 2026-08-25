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
import { parseSs, SS_ARGS } from "../src/lib/providers/ports/ss";
import { parseLsof } from "../src/lib/providers/ports/lsof";
import { AppleShareProvider } from "../src/lib/providers/shares/apple-provider";
import { ShareError, type DiscoveredShare } from "../src/lib/providers/shares/types";
import { needsDocker } from "../src/plugins/routeCompose";

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

  test("guest counters are not double-counted", () => {
    // The kernel already includes `guest` within `user` and `guest_nice` within `nice`.
    // Adding the last two fields again inflates the total, which understates usage on a
    // host running VMs.
    const withGuests = `cpu  100 10 40 800 50 0 0 0 70 5\n`;
    const s = parseProcStat(withGuests);
    expect(s.total).toBe(100 + 10 + 40 + 800 + 50); // not + 70 + 5
  });

  test("a kernel reporting fewer fields still parses", () => {
    // Older kernels stop at softirq; slicing must not invent NaN.
    const short = `cpu  100 10 40 800 50 0 0\n`;
    expect(parseProcStat(short).total).toBe(1000);
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

  test("the shortest mount labels the device, whatever order df used", () => {
    // A bind mount listed first must not become the label for the root filesystem —
    // observed in a container, where /dev/vda1 appears only as /etc/hosts.
    const rows = parseDf(`Filesystem 1024-blocks Used Available Capacity Mounted on
/dev/sda1  100 50 50 50% /mnt/bind/deep/path
/dev/sda1  100 50 50 50% /
`);
    const [only] = dedupeByDevice(rows);
    expect(only!.mount).toBe("/");
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

  test("each query asks for listeners of one protocol only", () => {
    // -l is what restricts the answer to listening sockets; without it `ss` reports every
    // socket, and established TCP connections were being labelled as UDP listeners.
    expect(SS_ARGS.tcp).toEqual(["-Htlnp"]);
    expect(SS_ARGS.udp).toEqual(["-Hulnp"]);
    for (const [proto, args] of Object.entries(SS_ARGS)) {
      const flags = args[0]!;
      expect(flags).toContain("l");                          // listening only
      expect(flags).toContain(proto === "tcp" ? "t" : "u");  // the right protocol
      expect(flags).not.toContain(proto === "tcp" ? "u" : "t");
    }
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

// ─── Apple share updates ─────────────────────────────────────────────────────

describe("AppleShareProvider.update — which changes reach the backend", () => {
  /**
   * The provider is exercised through a recording stub rather than `sharing` itself: the
   * question here is which commands would be issued, and running the real tool would
   * mutate the host's Open Directory.
   */
  class Recorder extends AppleShareProvider {
    calls: string[][] = [];
    listResult: DiscoveredShare[] = [];
    protected override async run(args: string[]): Promise<string> { this.calls.push(args); return ""; }
    override async list(): Promise<DiscoveredShare[]> { return this.listResult; }
  }

  const existing: DiscoveredShare = {
    name: "docs", path: "/old/path", comment: "", readOnly: false,
    browseable: true, guestOk: true, source: "external",
  };

  test("a path-only change is not silently dropped", async () => {
    // sync() emits exactly this patch when only the path differs. The early return used to
    // swallow it, leaving the sharepoint on the old directory while the UI showed the new.
    const p = new Recorder();
    p.listResult = [existing];
    await p.update("docs", { path: "/new/path" });

    const verbs = p.calls.map(c => c[0]);
    expect(verbs).toContain("-r"); // removed
    expect(verbs).toContain("-a"); // and recreated at the new path
    const create = p.calls.find(c => c[0] === "-a")!;
    expect(create).toContain("/new/path");
  });

  test("a flag-only change issues one edit and no recreate", async () => {
    const p = new Recorder();
    p.listResult = [existing];
    await p.update("docs", { readOnly: true });

    expect(p.calls).toHaveLength(1);
    expect(p.calls[0]![0]).toBe("-e");
    expect(p.calls[0]).toContain("-R");
  });

  test("a change the backend cannot store does nothing at all", async () => {
    // `comment` lives in SQLite only; issuing a bare `sharing -e docs` would be pointless.
    const p = new Recorder();
    p.listResult = [existing];
    await p.update("docs", { comment: "new description" });
    expect(p.calls).toHaveLength(0);
  });

  test("a rename moves both identifiers", async () => {
    // -n is the lookup key, -S is what clients see; moving only one leaves the share
    // answering to a name the user is not shown.
    const p = new Recorder();
    p.listResult = [existing];
    await p.update("docs", { name: "documents" });
    expect(p.calls[0]).toEqual(["-e", "docs", "-n", "documents", "-S", "documents"]);
  });
});

// ─── Apple share updates — failure recovery ──────────────────────────────────

describe("AppleShareProvider.update — a failed move must not destroy the share", () => {
  /**
   * `sharing` cannot move a sharepoint, so a path change is remove-then-recreate and the
   * share briefly does not exist. These cover what happens when the recreate fails, which
   * is the window in which a request to *move* a share could instead delete it.
   */
  class FailingCreate extends AppleShareProvider {
    calls: string[][] = [];
    listResult: DiscoveredShare[] = [];
    /** How many `-a` calls to fail before letting one through. */
    failCreates = 1;

    protected override async run(args: string[]): Promise<string> {
      this.calls.push(args);
      if (args[0] === "-a" && this.failCreates > 0) {
        this.failCreates--;
        throw new ShareError("bad-path", "sharing: unable to stat '/new/path'");
      }
      return "";
    }
    override async list(): Promise<DiscoveredShare[]> { return this.listResult; }
  }

  const existing: DiscoveredShare = {
    name: "docs", path: "/old/path", comment: "notes", readOnly: true,
    browseable: true, guestOk: false, source: "external",
  };

  test("the original share is restored when the recreate fails", async () => {
    const p = new FailingCreate();
    p.listResult = [existing];

    await expect(p.update("docs", { path: "/new/path" })).rejects.toThrow(/unable to stat/);

    // Second -a is the rollback, and it must restore the original path and flags.
    const creates = p.calls.filter(c => c[0] === "-a");
    expect(creates).toHaveLength(2);
    expect(creates[1]).toContain("/old/path");
    expect(creates[1]).toContain("-R");
    expect(creates[1]![creates[1]!.indexOf("-R") + 1]).toBe("1");     // readOnly preserved
    expect(creates[1]![creates[1]!.indexOf("-g") + 1]).toBe("000");   // guestOk preserved
  });

  test("the caller sees the original failure, not the rollback", async () => {
    const p = new FailingCreate();
    p.listResult = [existing];
    // The user asked to move a share and gave a bad path; that is what they need told.
    await expect(p.update("docs", { path: "/new/path" })).rejects.toThrow(/unable to stat/);
  });

  test("when the rollback also fails, the error says the share is gone", async () => {
    const p = new FailingCreate();
    p.listResult = [existing];
    p.failCreates = 2; // the move and the restore both fail

    // Reporting only "unable to stat" would imply nothing had changed, which is the one
    // thing that is not true here.
    await expect(p.update("docs", { path: "/new/path" })).rejects.toThrow(/no longer exists/);
  });

  test("a move that succeeds does not attempt a rollback", async () => {
    const p = new FailingCreate();
    p.listResult = [existing];
    p.failCreates = 0;

    await p.update("docs", { path: "/new/path" });
    expect(p.calls.filter(c => c[0] === "-a")).toHaveLength(1);
    expect(p.calls.filter(c => c[0] === "-r")).toHaveLength(1);
  });
});

// ─── Compose route scoping ───────────────────────────────────────────────────

describe("needsDocker — which compose routes require the daemon", () => {
  /**
   * The Docker guard used to be dead code: it tested whether `bins.docker` was *defined*,
   * which is true on every supported OS. Making it a real availability check turned it on
   * for the first time and it began refusing endpoints that never touch Docker — so a host
   * without Docker installed could not read its own compose file.
   */
  test("reads of files and metadata do not need Docker", () => {
    for (const path of [
      "/api/compose/tags",
      "/api/compose/compose-sources",
      "/api/compose/stacks/plex/install-log",
      "/api/compose/stacks/plex/file",
      "/api/compose/stacks/plex/compose-source",
      "/api/compose/stacks/plex/envfile",
    ]) {
      expect(needsDocker("GET", path)).toBe(false);
    }
  });

  test("anything that drives containers does need Docker", () => {
    for (const [method, path] of [
      ["POST", "/api/compose/stacks"],
      ["POST", "/api/compose/stacks/plex/pull"],
      ["POST", "/api/compose/stacks/plex/down"],
      ["POST", "/api/compose/stacks/plex/restart"],
      ["GET",  "/api/compose/stacks/plex/logs"],
      ["POST", "/api/compose/stacks/plex/repair"],
      ["GET",  "/api/compose/stacks/plex/containers"],
    ] as const) {
      expect(needsDocker(method, path)).toBe(true);
    }
  });

  test("the two /file routes are classified by method, not path", () => {
    // GET returns the compose file. PUT rewrites it and then runs `docker compose up`, so
    // exempting it would persist the user's edit and fail on the deploy — leaving the file
    // changed and the containers untouched.
    expect(needsDocker("GET", "/api/compose/stacks/plex/file")).toBe(false);
    expect(needsDocker("PUT", "/api/compose/stacks/plex/file")).toBe(true);
  });

  test("writing an env file touches no container", () => {
    expect(needsDocker("PUT", "/api/compose/stacks/plex/envfile")).toBe(false);
    expect(needsDocker("GET", "/api/compose/stacks/plex/envfile")).toBe(false);
  });

  test("a stack named after an exempt endpoint does not slip past the guard", () => {
    // Suffix matching would read PUT /api/compose/stacks/file as the exempt "…/file"
    // endpoint and let a redeploy through unchecked. Whole-path matching does not.
    expect(needsDocker("PUT", "/api/compose/stacks/file")).toBe(true);
    expect(needsDocker("GET", "/api/compose/stacks/tags")).toBe(true);
    expect(needsDocker("GET", "/api/compose/stacks/envfile")).toBe(true);
    // The genuine per-stack endpoint is still exempt.
    expect(needsDocker("GET", "/api/compose/stacks/file/file")).toBe(false);
  });

  test("nested paths below an exempt endpoint are not exempt", () => {
    expect(needsDocker("GET", "/api/compose/stacks/plex/file/extra")).toBe(true);
    expect(needsDocker("GET", "/api/compose/stacks/plex/containers/abc/logs")).toBe(true);
  });

  test("an unlisted method on an exempt path still requires Docker", () => {
    // Exemptions are opt-in per verb, so a route added later is guarded by default.
    expect(needsDocker("DELETE", "/api/compose/stacks/plex/envfile")).toBe(true);
    expect(needsDocker("POST", "/api/compose/tags")).toBe(true);
  });

  test("the method is matched case-insensitively", () => {
    expect(needsDocker("get", "/api/compose/tags")).toBe(false);
  });
});
