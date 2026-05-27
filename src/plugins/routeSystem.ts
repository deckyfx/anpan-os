import { Elysia } from "elysia";
import { authGuard } from "./authGuard";
import { bins, commands } from "../lib/commands";
import { envConfig } from "../env-config";

// Injected at build time via define; falls back to reading package.json from CWD in dev.
const APP_VERSION: string =
  (process.env.APP_VERSION as string | undefined) ??
  ((await Bun.file("package.json").json()) as { version?: string }).version ??
  "0.0.0";

export function systemPlugin(jwtSecret: string) {
  return new Elysia({ prefix: "/api/system" })
    .use(authGuard(jwtSecret))
    .get("/info", () => ({ version: APP_VERSION, configDir: envConfig.RUNTIME_CONFIG_DIR }))
    .get("/stats", async () => {
      const [cpu, ram, disk] = await Promise.all([getCpu(), getRam(), getDisk()]);
      return { cpu, ...ram, ...disk };
    })
    .get("/doctor", () => commands.doctor())
    .post("/restart",  async ({ set }) => {
      if ((process.getuid?.() ?? -1) !== 0) { set.status = 403; return { error: "Requires root" }; }
      void Bun.$`systemctl reboot`.quiet().nothrow();
      return { ok: true };
    })
    .post("/shutdown", async ({ set }) => {
      if ((process.getuid?.() ?? -1) !== 0) { set.status = 403; return { error: "Requires root" }; }
      void Bun.$`systemctl poweroff`.quiet().nothrow();
      return { ok: true };
    })
    .get("/environment", async () => {
      const [whoamiRes, uidRes, sambaWhichRes] = await Promise.all([
        Bun.$`whoami`.quiet().nothrow(),
        Bun.$`id -u`.quiet().nothrow(),
        Bun.$`which smbd`.quiet().nothrow(),
      ]);

      const user   = whoamiRes.stdout.toString().trim() || (process.env.USER ?? "unknown");
      const uid    = parseInt(uidRes.stdout.toString().trim(), 10);
      const isRoot = uid === 0;

      const sambaInstalled = sambaWhichRes.exitCode === 0;

      let sambaActive  = false;
      let sambaEnabled = false;
      if (sambaInstalled) {
        const [activeRes, enabledRes] = await Promise.all([
          Bun.$`systemctl is-active smbd`.quiet().nothrow(),
          Bun.$`systemctl is-enabled smbd`.quiet().nothrow(),
        ]);
        sambaActive  = activeRes.stdout.toString().trim()  === "active";
        sambaEnabled = enabledRes.stdout.toString().trim() === "enabled";
      }

      return { user, uid, isRoot, samba: { installed: sambaInstalled, active: sambaActive, enabled: sambaEnabled } };
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
        const updateAvailable = latestVersion !== APP_VERSION && latestVersion !== "";

        const arch        = process.arch === "arm64" ? "arm64" : "x64";
        const binaryName  = `anpan-os-linux-${arch}`;
        const assets      = data.assets ?? [];
        const downloadUrl = assets.find(a => a.name === binaryName)?.browser_download_url ?? "";
        const sha256Url   = assets.find(a => a.name === `${binaryName}.sha256`)?.browser_download_url ?? "";

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

      const arch       = process.arch === "arm64" ? "arm64" : "x64";
      const binaryName = `anpan-os-linux-${arch}`;
      const assets     = release.assets ?? [];
      const binaryUrl  = assets.find(a => a.name === binaryName)?.browser_download_url;
      const sha256Url  = assets.find(a => a.name === `${binaryName}.sha256`)?.browser_download_url;

      if (!binaryUrl || !sha256Url) { set.status = 404; return { error: `No release asset found for ${binaryName}` }; }

      // Download checksum file
      const sha256Res = await fetch(sha256Url, { signal: AbortSignal.timeout(15_000) });
      if (!sha256Res.ok) { set.status = 502; return { error: "Failed to download checksum file" }; }
      const sha256Text    = await sha256Res.text();
      const expectedHash  = sha256Text.trim().split(/\s+/)[0] ?? "";

      // Download binary
      const tmpPath = "/tmp/anpan-os-update";
      const binRes  = await fetch(binaryUrl, { signal: AbortSignal.timeout(120_000) });
      if (!binRes.ok) { set.status = 502; return { error: "Failed to download binary" }; }
      const binaryBuffer = await binRes.arrayBuffer();

      // Verify SHA256
      const hasher   = new Bun.CryptoHasher("sha256");
      hasher.update(binaryBuffer);
      const actualHash = hasher.digest("hex");
      if (actualHash !== expectedHash) { set.status = 422; return { error: "SHA256 mismatch — download may be corrupted" }; }

      // Write to temp path, make executable, then replace the running binary
      await Bun.write(tmpPath, binaryBuffer);
      await Bun.$`chmod +x ${tmpPath}`.quiet();
      await Bun.$`mv ${tmpPath} /usr/local/bin/anpan-os`.quiet();

      // Fire-and-forget restart (response is sent before the process dies)
      void Bun.$`systemctl restart anpan-os`.quiet().nothrow();

      return { ok: true };
    });
}

/** CPU usage % — two /proc/stat samples 150 ms apart. */
async function getCpu(): Promise<number> {
  const sample = async () => {
    const text = await Bun.file("/proc/stat").text();
    const parts = text.split("\n")[0]!.trim().split(/\s+/).slice(1).map(Number);
    const idle  = (parts[3] ?? 0) + (parts[4] ?? 0); // idle + iowait
    const total = parts.reduce((a, b) => a + b, 0);
    return { idle, total };
  };

  const s1 = await sample();
  await Bun.sleep(150);
  const s2 = await sample();

  const deltaIdle  = s2.idle  - s1.idle;
  const deltaTotal = s2.total - s1.total;
  if (deltaTotal === 0) return 0;
  return Math.round((1 - deltaIdle / deltaTotal) * 100);
}

/** RAM from /proc/meminfo — returns bytes. */
async function getRam(): Promise<{ ramUsed: number; ramTotal: number }> {
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

interface DiskMount {
  device: string;
  mount: string;
  used: number;
  total: number;
}

/** All physical disk mounts from `df -k`. Filters out virtual filesystems. */
async function getDisk(): Promise<{ disks: DiskMount[] }> {
  const result = await Bun.$`${bins.df} -k`.quiet().nothrow();
  const lines  = result.stdout.toString().trim().split("\n").slice(1);
  const disks: DiskMount[] = [];
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 6) continue;
    const device = parts[0]!;
    // Only real block devices (skip tmpfs, devtmpfs, squashfs, overlay, etc.)
    if (!device.startsWith("/dev/")) continue;
    const total = parseInt(parts[1]!, 10) * 1024;
    const used  = parseInt(parts[2]!, 10) * 1024;
    const mount = parts[5]!;
    disks.push({ device, mount, used, total });
  }
  return { disks };
}
