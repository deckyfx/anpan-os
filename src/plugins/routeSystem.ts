import { Elysia } from "elysia";
import { cpus, freemem, totalmem } from "node:os";
import { join } from "node:path";
import { authGuard } from "./authGuard";
import {
  ARCH, FEATURES, IS_LINUX, IS_MACOS, PLATFORM, PLATFORM_LABEL, TMP_DIR,
  binaryName, currentBinaryPath, detectSamba, poweroffCommand, rebootCommand, restartSelfCommand,
} from "../lib/platform";
import { bins, commands } from "../lib/commands";
import { envConfig } from "../env-config";

function semverGt(a: string, b: string): boolean {
  const parse = (v: string) => v.replace(/^v/, "").split(".").map(n => parseInt(n, 10) || 0);
  const [aMaj = 0, aMin = 0, aPatch = 0] = parse(a);
  const [bMaj = 0, bMin = 0, bPatch = 0] = parse(b);
  if (aMaj !== bMaj) return aMaj > bMaj;
  if (aMin !== bMin) return aMin > bMin;
  return aPatch > bPatch;
}

// Injected at build time via define; falls back to reading package.json from CWD in dev.
const APP_VERSION: string =
  (process.env.APP_VERSION as string | undefined) ??
  ((await Bun.file("package.json").json()) as { version?: string }).version ??
  "0.0.0";

export function systemPlugin(jwtSecret: string) {
  return new Elysia({ prefix: "/api/system" })
    .use(authGuard(jwtSecret))
    // The UI reads `features` to decide what to render at all — see lib/platform.
    // Samba is resolved rather than assumed: /usr/sbin/smbd exists on every Mac but is
    // Apple's SMBX, which ignores smb.conf, so "smbd is present" is not "shares work".
    .get("/info", async () => {
      const samba = await detectSamba();
      return {
        version:   APP_VERSION,
        configDir: envConfig.RUNTIME_CONFIG_DIR,
        platform:  PLATFORM,
        arch:      ARCH,
        platformLabel: PLATFORM_LABEL,
        features:  { ...FEATURES, samba: samba.manageable },
        smb:       samba,
      };
    })
    .get("/stats", async () => {
      const [cpu, ram, disk] = await Promise.all([getCpu(), getRam(), getDisk()]);
      return { cpu, ...ram, ...disk };
    })
    .get("/doctor", () => commands.doctor())
    .post("/restart",  async ({ set }) => power(set, rebootCommand()))
    .post("/shutdown", async ({ set }) => power(set, poweroffCommand()))
    .get("/environment", async () => {
      const uid    = process.getuid?.() ?? -1;
      const isRoot = uid === 0;
      const user   = (await Bun.$`whoami`.quiet().nothrow()).stdout.toString().trim()
                     || process.env.USER
                     || (isRoot ? "root" : "unknown");

      const smb = await detectSamba();
      // "installed" means a server anpan-os can actually drive. Apple's SMBX is running
      // software, but not something these routes can configure, and reporting it as
      // installed would put a working-looking share dialog in front of the user.
      const state = smb.manageable
        ? await sambaServiceState()
        : { active: false, enabled: false };

      return {
        user, uid, isRoot,
        platform: PLATFORM,
        arch: ARCH,
        samba: { installed: smb.manageable, flavor: smb.flavor, reason: smb.reason, ...state },
      };
    })
    .get("/update-check", async () => {
      try {
        const res = await fetch(
          "https://api.github.com/repos/deckyfx/anpan-os/releases/latest",
          {
            headers: { "User-Agent": "anpan-os" },
            signal: AbortSignal.timeout(10_000),
          },
        );
        if (!res.ok) return { updateAvailable: false, currentVersion: APP_VERSION, error: `GitHub API returned ${res.status}` };

        const data = await res.json() as {
          tag_name: string;
          body?: string;
          assets?: { name: string; browser_download_url: string }[];
        };

        const latestVersion = (data.tag_name ?? "").replace(/^v/, "");
        const updateAvailable = latestVersion !== "" && semverGt(latestVersion, APP_VERSION);

        // Asset for *this* host, not always the Linux one — downloading a Linux ELF
        // onto a Mac and marking it executable produces a service that cannot start.
        const asset       = binaryName();
        const assets      = data.assets ?? [];
        const downloadUrl = assets.find(a => a.name === asset)?.browser_download_url ?? "";
        const sha256Url   = assets.find(a => a.name === `${asset}.sha256`)?.browser_download_url ?? "";

        return {
          currentVersion: APP_VERSION,
          latestVersion,
          updateAvailable,
          releaseNotes: data.body ?? "",
          downloadUrl,
          sha256Url,
        };
      } catch (e) {
        return { updateAvailable: false, currentVersion: APP_VERSION, error: String(e) };
      }
    })
    .post("/update", async ({ set }) => {
      if ((process.getuid?.() ?? -1) !== 0) { set.status = 403; return { error: "Requires root" }; }

      // Re-fetch latest release to get download URLs
      const releaseRes = await fetch(
        "https://api.github.com/repos/deckyfx/anpan-os/releases/latest",
        { headers: { "User-Agent": "anpan-os" }, signal: AbortSignal.timeout(15_000) },
      );
      if (!releaseRes.ok) { set.status = 502; return { error: `GitHub API returned ${releaseRes.status}` }; }

      const release = await releaseRes.json() as {
        assets?: { name: string; browser_download_url: string }[];
      };

      const asset     = binaryName();
      const assets    = release.assets ?? [];
      const binaryUrl = assets.find(a => a.name === asset)?.browser_download_url;
      const sha256Url = assets.find(a => a.name === `${asset}.sha256`)?.browser_download_url;

      if (!binaryUrl || !sha256Url) { set.status = 404; return { error: `No release asset found for ${asset}` }; }

      // Download checksum file
      const sha256Res = await fetch(sha256Url, { signal: AbortSignal.timeout(15_000) });
      if (!sha256Res.ok) { set.status = 502; return { error: "Failed to download checksum file" }; }
      const sha256Text    = await sha256Res.text();
      const expectedHash  = sha256Text.trim().split(/\s+/)[0] ?? "";

      // Download binary. os.tmpdir(), not a literal /tmp: on macOS each user gets a
      // private sandbox under /var/folders and TMPDIR points at it.
      const tmpPath = join(TMP_DIR, "anpan-os-update");
      const binRes  = await fetch(binaryUrl, { signal: AbortSignal.timeout(120_000) });
      if (!binRes.ok) { set.status = 502; return { error: "Failed to download binary" }; }
      const binaryBuffer = await binRes.arrayBuffer();

      // Verify SHA256
      const hasher   = new Bun.CryptoHasher("sha256");
      hasher.update(binaryBuffer);
      const actualHash = hasher.digest("hex");
      if (actualHash !== expectedHash) { set.status = 422; return { error: "SHA256 mismatch — download may be corrupted" }; }

      // Replace the binary this process is running from, wherever the installer put it,
      // rather than assuming /usr/local/bin — a self-update that writes somewhere other
      // than the path the service unit launches would appear to succeed and change nothing.
      const target = currentBinaryPath();

      await Bun.write(tmpPath, binaryBuffer);
      await Bun.$`chmod +x ${tmpPath}`.quiet();

      // rename() cannot cross filesystems, and on macOS the temp dir is a different volume
      // from /usr/local. `mv` falls back to copy+unlink, which rename() does not.
      const moved = await Bun.$`mv -f ${tmpPath} ${target}`.quiet().nothrow();
      if (moved.exitCode !== 0) {
        set.status = 500;
        return { error: `Could not replace ${target}: ${moved.stderr.toString().trim()}` };
      }

      // Fire-and-forget restart (the response is sent before the process dies).
      const restart = restartSelfCommand();
      if (restart) void Bun.$`${restart}`.quiet().nothrow();

      return { ok: true, restarted: restart !== null };
    });
}

// ─── Power control ───────────────────────────────────────────────────────────

/**
 * Reboot or power off the host.
 *
 * Both platforms need root for this, and neither can be asked politely: `shutdown` and
 * `systemctl poweroff` refuse outright for an unprivileged caller, so the check is a
 * clearer 403 than the shell error would be. Fire-and-forget — the machine goes down
 * before a second response could be written.
 */
function power(set: { status?: number | string }, argv: string[] | null): { ok: true } | { error: string } {
  if ((process.getuid?.() ?? -1) !== 0) { set.status = 403; return { error: "Requires root" }; }
  if (!argv) { set.status = 501; return { error: `Power control is not supported on ${PLATFORM_LABEL}` }; }
  void Bun.$`${argv}`.quiet().nothrow();
  return { ok: true };
}

// ─── Samba service state ─────────────────────────────────────────────────────

/**
 * Whether smbd is running, and whether it starts at boot.
 *
 * systemd answers both questions directly. launchd has no "enabled" concept in the same
 * sense — a job is either loaded into a domain or it is not — so `launchctl print`
 * standing in for is-active, and the job being listed at all standing in for is-enabled,
 * is the closest honest mapping. Apple's own sharing daemon (com.apple.smbd) and a
 * Homebrew samba both appear this way.
 */
async function sambaServiceState(): Promise<{ active: boolean; enabled: boolean }> {
  if (IS_LINUX) {
    const [activeRes, enabledRes] = await Promise.all([
      Bun.$`systemctl is-active smbd`.quiet().nothrow(),
      Bun.$`systemctl is-enabled smbd`.quiet().nothrow(),
    ]);
    return {
      active:  activeRes.stdout.toString().trim()  === "active",
      enabled: enabledRes.stdout.toString().trim() === "enabled",
    };
  }

  if (IS_MACOS) {
    // A running smbd is the fact that matters, and pgrep answers it without caring which
    // of the two possible samba installs launchd is managing.
    const running = await Bun.$`pgrep -x smbd`.quiet().nothrow();
    const loaded  = await Bun.$`launchctl print system/com.apple.smbd`.quiet().nothrow();
    return { active: running.exitCode === 0, enabled: loaded.exitCode === 0 };
  }

  return { active: false, enabled: false };
}

// ─── CPU ─────────────────────────────────────────────────────────────────────

/**
 * CPU usage %, sampled over 150 ms.
 *
 * Both platforms report cumulative counters rather than a rate, so a single reading says
 * nothing — the number only exists as a difference between two samples. Linux reads
 * /proc/stat; macOS has no /proc at all, and node:os exposes the same per-core tick
 * counters the kernel keeps, which is what `top` derives its figure from.
 */
async function getCpu(): Promise<number> {
  const s1 = await cpuSample();
  await Bun.sleep(150);
  const s2 = await cpuSample();

  const deltaIdle  = s2.idle  - s1.idle;
  const deltaTotal = s2.total - s1.total;
  if (deltaTotal <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((1 - deltaIdle / deltaTotal) * 100)));
}

async function cpuSample(): Promise<{ idle: number; total: number }> {
  if (IS_LINUX) {
    const text  = await Bun.file("/proc/stat").text();
    const parts = text.split("\n")[0]!.trim().split(/\s+/).slice(1).map(Number);
    const idle  = (parts[3] ?? 0) + (parts[4] ?? 0); // idle + iowait
    const total = parts.reduce((a, b) => a + b, 0);
    return { idle, total };
  }

  // Summed across cores: os.cpus() reports each core's ticks separately, and the ratio of
  // the sums is the whole-machine figure.
  let idle = 0, total = 0;
  for (const core of cpus()) {
    idle  += core.times.idle;
    total += core.times.user + core.times.nice + core.times.sys + core.times.idle + core.times.irq;
  }
  return { idle, total };
}

// ─── RAM ─────────────────────────────────────────────────────────────────────

/** RAM in bytes. */
async function getRam(): Promise<{ ramUsed: number; ramTotal: number }> {
  return IS_LINUX ? linuxRam() : darwinRam();
}

async function linuxRam(): Promise<{ ramUsed: number; ramTotal: number }> {
  const text  = await Bun.file("/proc/meminfo").text();
  const lines = text.split("\n");
  const get   = (key: string) => {
    const line = lines.find((l) => l.startsWith(key));
    return line ? parseInt(line.split(/\s+/)[1]!, 10) * 1024 : 0;
  };
  const total = get("MemTotal:");
  const avail = get("MemAvailable:");
  return { ramUsed: total - avail, ramTotal: total };
}

/**
 * RAM on macOS, from `vm_stat`.
 *
 * `os.freemem()` is not usable here. macOS treats almost all unallocated memory as file
 * cache, so freemem() on a healthy machine reports a few hundred MB and the gauge would
 * sit at 95% permanently. What Activity Monitor calls "memory used" is the sum of the
 * pages that are genuinely spoken for — wired, active, compressed — which is what vm_stat
 * breaks out. Falls back to the free/total pair if vm_stat is unavailable or unparseable.
 */
async function darwinRam(): Promise<{ ramUsed: number; ramTotal: number }> {
  const ramTotal = totalmem();

  const res = await Bun.$`${bins.vm_stat ?? "vm_stat"}`.quiet().nothrow();
  if (res.exitCode !== 0) return { ramUsed: ramTotal - freemem(), ramTotal };

  const out = res.stdout.toString();

  // "Mach Virtual Memory Statistics: (page size of 16384 bytes)" — 16K on Apple Silicon,
  // 4K on Intel, so it must be read rather than assumed.
  const pageSize = parseInt(out.match(/page size of (\d+) bytes/)?.[1] ?? "4096", 10);

  const pages = (label: string): number => {
    const m = out.match(new RegExp(`^${label}:\\s+(\\d+)\\.?`, "m"));
    return m ? parseInt(m[1]!, 10) : 0;
  };

  const wired      = pages("Pages wired down");
  const active     = pages("Pages active");
  const compressed = pages("Pages occupied by compressor");

  const used = (wired + active + compressed) * pageSize;
  if (used <= 0) return { ramUsed: ramTotal - freemem(), ramTotal };

  return { ramUsed: Math.min(used, ramTotal), ramTotal };
}

// ─── Disk ────────────────────────────────────────────────────────────────────

interface DiskMount {
  device: string;
  mount: string;
  used: number;
  total: number;
}

/**
 * Mount points that describe the OS rather than the user's storage.
 *
 * macOS mounts a dozen of these. /System/Volumes/* are the firmlinked pieces of the boot
 * container, and CoreSimulator mounts are disk images Xcode attaches for each simulator
 * runtime — real mounts, but not disks anyone manages from a dashboard.
 */
function isSystemMount(mount: string): boolean {
  return mount === "/System/Volumes/Data"
    ? false // the user's actual data volume, despite living under /System
    : mount.startsWith("/System/Volumes/")
      || mount.startsWith("/Library/Developer/CoreSimulator/")
      || mount.startsWith("/private/var/vm");
}

/**
 * Split an APFS device into its container and volume.
 *
 * /dev/disk3s5     → { container: "disk3", volume: "disk3s5" }
 * /dev/disk3s1s1   → { container: "disk3", volume: "disk3s1" }  (a snapshot of disk3s1)
 *
 * The snapshot suffix has to be stripped or the boot volume is counted twice: macOS mounts
 * the sealed system snapshot at "/" and the volume it was taken from at
 * /System/Volumes/Update/mnt1, both reporting the same bytes.
 */
function apfsParts(device: string): { container: string; volume: string } | null {
  const m = device.match(/^\/dev\/(disk\d+)(s\d+)(s\d+)?$/);
  if (!m) return null;
  return { container: m[1]!, volume: `${m[1]}${m[2]}` };
}

/**
 * All physical disk mounts, from `df -Pk`.
 *
 * -P is what makes the parsing one code path instead of two: macOS `df -k` appends inode
 * columns, so the mount point lands in field 9 there and field 6 on Linux. POSIX output
 * mode fixes the format at six fields on both, with the mount point last.
 *
 * The grouping below is macOS-only and not cosmetic. APFS puts several volumes in one
 * container that share a single pool of free space, so a stock Mac reports twelve rows for
 * one 2 TB disk — each claiming the full 2 TB total and a fraction of the usage. Listing
 * them as-is showed a dozen disks and made none of the numbers mean anything. Summing the
 * volumes of a container gives the figure Finder shows, against the one total they share.
 */
async function getDisk(): Promise<{ disks: DiskMount[] }> {
  const result = await Bun.$`${bins.df ?? "df"} -Pk`.quiet().nothrow();
  const lines  = result.stdout.toString().trim().split("\n").slice(1);

  const rows: DiskMount[] = [];
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 6) continue;
    const device = parts[0]!;
    // Only real block devices (skip tmpfs, devfs, squashfs, overlay, map auto_home…)
    if (!device.startsWith("/dev/")) continue;
    const total = parseInt(parts[1]!, 10) * 1024;
    const used  = parseInt(parts[2]!, 10) * 1024;
    if (!Number.isFinite(total) || total <= 0) continue;
    // Mount points can contain spaces ("/Volumes/My Disk"), and -P puts the mount last.
    const mount = parts.slice(5).join(" ");
    rows.push({ device, mount, used, total });
  }

  if (!IS_MACOS) {
    // One entry per device. A device mounted more than once is one disk, not several.
    const seen = new Set<string>();
    return { disks: rows.filter((d) => !seen.has(d.device) && seen.add(d.device)) };
  }

  interface Container { total: number; used: number; volumes: Set<string>; mounts: string[] }
  const containers = new Map<string, Container>();
  const plain: DiskMount[] = [];

  for (const row of rows) {
    const parts = apfsParts(row.device);
    if (!parts) { plain.push(row); continue; }

    let c = containers.get(parts.container);
    if (!c) {
      c = { total: 0, used: 0, volumes: new Set(), mounts: [] };
      containers.set(parts.container, c);
    }

    c.total = Math.max(c.total, row.total);
    c.mounts.push(row.mount);
    // Each volume contributes once, however many places it is mounted.
    if (!c.volumes.has(parts.volume)) {
      c.volumes.add(parts.volume);
      c.used += row.used;
    }
  }

  const disks: DiskMount[] = [];
  for (const [container, c] of containers) {
    // Prefer the mount a person would recognise. "/" is the boot disk; otherwise the
    // shortest path, which is the parent of any nested mounts in the same container.
    const userMounts = c.mounts.filter((m) => !isSystemMount(m));
    const mount = c.mounts.includes("/")
      ? "/"
      : [...(userMounts.length ? userMounts : c.mounts)].sort((a, b) => a.length - b.length)[0]!;

    // A container with nothing but system mounts is Apple's, not the user's — the
    // recovery and simulator containers rather than a disk anyone manages.
    if (mount !== "/" && isSystemMount(mount)) continue;

    disks.push({ device: `/dev/${container}`, mount, used: c.used, total: c.total });
  }

  for (const row of plain) {
    if (!isSystemMount(row.mount)) disks.push(row);
  }

  return { disks };
}
