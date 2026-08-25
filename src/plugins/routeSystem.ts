import { Elysia } from "elysia";
import { join } from "node:path";
import { authGuard } from "./authGuard";
import { metrics, ports, service, shareProvider } from "../lib/providers";
import {
  ARCH, FEATURES, PLATFORM, PLATFORM_LABEL, TMP_DIR,
  binaryName, currentBinaryPath, detectSamba,
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
      // Whether shares can be managed is a question about the provider, not about Samba.
      // detectSamba() answers only "is this a real Samba install", which was the whole
      // story before the Apple provider existed and is now half of it: a stock Mac has no
      // Samba and full share management. Reporting `manageable` here said otherwise.
      const provider = await shareProvider();
      return {
        version:   APP_VERSION,
        configDir: envConfig.RUNTIME_CONFIG_DIR,
        platform:  PLATFORM,
        arch:      ARCH,
        platformLabel: PLATFORM_LABEL,
        features:  { ...FEATURES, samba: provider !== null },
        // `reason` is advice for a host that cannot manage shares at all. Emitting it
        // beside a working provider produced a self-contradicting payload — "installed,
        // and also: no SMB server found" — so readiness comes from the provider instead.
        smb: provider
          ? { provider: provider.id, flavor: samba.flavor, ...(await provider.status()) }
          : { provider: null, flavor: samba.flavor, ready: false, detail: samba.reason ?? "", fixable: false },
      };
    })
    .get("/stats", async () => {
      const [cpu, ram, disks] = await Promise.all([metrics.cpu(), metrics.ram(), metrics.disks()]);
      return { cpu, ...ram, disks };
    })
    .get("/doctor", () => commands.doctor())
    .post("/restart",  ({ set }) => power(set, service.rebootCommand()))
    .post("/shutdown", ({ set }) => power(set, service.poweroffCommand()))
    .get("/environment", async () => {
      const uid    = process.getuid?.() ?? -1;
      const isRoot = uid === 0;
      const user   = (await Bun.$`whoami`.quiet().nothrow()).stdout.toString().trim()
                     || process.env.USER
                     || (isRoot ? "root" : "unknown");

      const smb      = await detectSamba();
      const provider = await shareProvider();
      // "installed" means a server anpan-os can actually drive — which now includes
      // Apple's, through the native provider.
      const state = provider ? await service.state("smbd") : { active: false, enabled: false };

      return {
        user, uid, isRoot,
        platform: PLATFORM,
        arch: ARCH,
        samba: {
          installed: provider !== null,
          provider:  provider?.id ?? null,
          flavor:    smb.flavor,
          // Only when nothing can manage shares — otherwise this said "no SMB server
          // found" next to installed: true.
          reason:    provider ? undefined : smb.reason,
          ...state,
        },
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

      // Refuse unless this process *is* the compiled binary.
      //
      // The update replaces process.execPath. Under `bun run src/index.ts` that is the Bun
      // runtime itself, so a self-update in source mode would overwrite the user's Bun
      // installation with an anpan-os binary. The build-mode flag is the only reliable
      // signal — the executable's name is not, since a compiled binary can be renamed and
      // `bun` cannot.
      if (!envConfig.IS_BINARY_MODE) {
        set.status = 409;
        return { error: "Self-update is only available for an installed binary, not a source-mode run." };
      }

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
      const restart = service.restartSelfCommand();
      if (restart) void Bun.$`${restart}`.quiet().nothrow();

      return { ok: true, restarted: restart !== null };
    });
}

// ─── Power control ───────────────────────────────────────────────────────────

/**
 * Reboot or power off the host.
 *
 * Both platforms need root, and neither asks politely: `shutdown` and `systemctl poweroff`
 * refuse outright for an unprivileged caller, so checking first gives a clearer 403 than
 * the shell error would. Fire-and-forget — the machine goes down before a second response
 * could be written.
 */
function power(set: { status?: number | string }, argv: string[] | null): { ok: true } | { error: string } {
  if ((process.getuid?.() ?? -1) !== 0) { set.status = 403; return { error: "Requires root" }; }
  if (!argv) { set.status = 501; return { error: `Power control is not supported on ${PLATFORM_LABEL}` }; }
  void Bun.$`${argv}`.quiet().nothrow();
  return { ok: true };
}
