import { Elysia } from "elysia";
import { authGuard } from "./authGuard";
import { metrics, ports, service, shareProvider } from "../lib/providers";
import {
  ARCH, FEATURES, PLATFORM, PLATFORM_LABEL,
  detectSamba,
} from "../lib/platform";
import { bins, commands } from "../lib/commands";
import { envConfig } from "../env-config";
import { listDrives } from "../lib/drives";
import { UpdateError, downloadVerified, fetchLatestRelease, installBinary, isNewer, withUpdateLock } from "../lib/self-update";

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
    /**
     * Drives and partitions for the file manager's quick-access list.
     *
     * Separate from /stats, which the dashboard polls for CPU and RAM: this one walks
     * sysfs, and there is no reason to pay for that on every dashboard tick.
     */
    .get("/drives", () => listDrives())
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
        const release = await fetchLatestRelease();
        return {
          currentVersion:  APP_VERSION,
          latestVersion:   release.version,
          updateAvailable: release.version !== "" && isNewer(release.version, APP_VERSION),
          releaseNotes:    release.notes,
          downloadUrl:     release.binaryUrl,
          sha256Url:       release.sha256Url,
        };
      } catch (e) {
        return { updateAvailable: false, currentVersion: APP_VERSION, error: e instanceof Error ? e.message : String(e) };
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

      return runUpdate(set);
    });
}

/**
 * Download the latest release, verify it and replace the running binary, then restart.
 *
 * The steps live in lib/self-update, shared with `anpan-os --upgrade`; this maps their
 * failures to HTTP statuses. The update lock is held across the download and the replace,
 * so neither a second click nor a CLI upgrade in another process can interleave with it.
 */
async function runUpdate(set: { status?: number | string }): Promise<Record<string, unknown>> {
  try {
    await withUpdateLock(async () => {
      const release = await fetchLatestRelease();
      await installBinary(await downloadVerified(release));
    });
  } catch (e) {
    if (e instanceof UpdateError) { set.status = e.status; return { error: e.message }; }
    throw e;
  }

  // Fire-and-forget restart (the response is sent before the process dies).
  const restart = service.restartSelfCommand();
  if (restart) void Bun.$`${restart}`.quiet().nothrow();
  return { ok: true, restarted: restart !== null };
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
