import { access, constants } from "node:fs/promises";
import { dirname } from "node:path";
import { envConfig } from "../env-config";
import { currentBinaryPath } from "../lib/platform";
import { service } from "../lib/providers/service";
import {
  UpdateError, downloadVerified, fetchLatestRelease, installBinary, isNewer, withUpdateLock,
} from "../lib/self-update";

/**
 * `anpan-os --upgrade [--check]` — install the latest release over this binary.
 *
 * The same steps as the web updater, from lib/self-update: download, verify the SHA-256,
 * replace atomically, restart the service. With --check it only reports.
 *
 * Exit codes: 0 on success or when already current, 1 on any failure.
 */
export async function runUpgrade(checkOnly: boolean): Promise<never> {
  const current = process.env.APP_VERSION ?? "dev";

  // From source, the "binary" is the Bun runtime itself, and replacing it would overwrite
  // the user's Bun installation with anpan-os.
  if (!envConfig.IS_BINARY_MODE) {
    fail("--upgrade replaces the installed binary, so it must be run from it, not from source.");
  }

  console.log(`anpan-os v${current} — checking for a newer release…`);
  let release;
  try {
    release = await fetchLatestRelease();
  } catch (e) {
    fail(`Could not check for updates: ${message(e)}`);
  }

  if (!release.version || !isNewer(release.version, current)) {
    console.log(`✅ Already up to date — v${current} is the latest release.`);
    process.exit(0);
  }
  console.log(`⬆️  v${release.version} is available.`);

  if (checkOnly) {
    console.log("   Run 'sudo anpan-os --upgrade' to install it.");
    process.exit(0);
  }

  // Asked up front rather than discovered after a 90 MB download fails to rename.
  const target = currentBinaryPath();
  if (!(await canReplace(target))) {
    fail(`Upgrading replaces ${target}, which needs root. Run: sudo anpan-os --upgrade`);
  }

  try {
    await withUpdateLock(async () => {
      const bytes = await downloadVerified(release, progressPrinter());
      console.log("🔐 Checksum verified");
      await installBinary(bytes, target);
    }, target);
  } catch (e) {
    fail(e instanceof UpdateError ? e.message : `Upgrade failed: ${message(e)}`);
  }
  console.log(`✅ Installed v${release.version} at ${target}`);

  await restartService();
  process.exit(0);
}

/** Whether this process may write the binary and the directory it is replaced through. */
async function canReplace(target: string): Promise<boolean> {
  try {
    await access(dirname(target), constants.W_OK);
    await access(target, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Restart the installed service so the new binary takes over.
 *
 * A separate process from the service, so restarting it does not cut this command short.
 * A binary run without a service has nothing to restart, which is reported, not treated as
 * a failure — the upgrade itself succeeded.
 */
async function restartService(): Promise<void> {
  const command = service.restartSelfCommand();
  if (!command) {
    console.log("   Restart anpan-os to run the new version.");
    return;
  }
  const result = await Bun.$`${command}`.quiet().nothrow();
  if (result.exitCode === 0) {
    console.log("🔄 Restarted the anpan-os service");
  } else {
    console.log(`⚠️  Could not restart the service (${command.join(" ")} exited ${result.exitCode}).`);
    console.log("   Restart anpan-os yourself to run the new version.");
  }
}

/**
 * Download progress: one line rewritten in place on a terminal, every 10% otherwise, so a
 * log file is not filled with a line per chunk.
 */
function progressPrinter(): (received: number, total: number | null) => void {
  const tty = process.stdout.isTTY;
  let lastStep = -1;
  return (received, total) => {
    const mb = (received / 1_048_576).toFixed(1);
    if (total === null) {
      if (tty) process.stdout.write(`\r⬇️  ${mb} MB`);
      return;
    }
    const pct = Math.floor((received / total) * 100);
    const line = `⬇️  ${mb} / ${(total / 1_048_576).toFixed(1)} MB (${pct}%)`;
    if (tty) {
      process.stdout.write(`\r${line}`);
      if (received >= total) process.stdout.write("\n");
    } else if (Math.floor(pct / 10) > lastStep) {
      lastStep = Math.floor(pct / 10);
      console.log(line);
    }
  };
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function fail(text: string): never {
  console.error(`❌ ${text}`);
  process.exit(1);
}
