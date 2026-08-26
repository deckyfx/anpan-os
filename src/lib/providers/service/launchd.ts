/** macOS services, via launchd. */

import { commands } from "../../commands";
import { LAUNCHD_LABEL } from "../../platform";
import type { ServiceCapabilities, ServiceProvider, ServiceState } from "./types";

/**
 * Map a plain service name to the launchd label that implements it.
 *
 * Callers ask for "smbd" because that is what the service is called; on macOS the job that
 * provides it is com.apple.smbd, and anpan-os's own job carries a reverse-DNS label of its
 * own. Unknown names are passed through, so a caller can still name a label directly.
 */
function labelFor(name: string): string {
  switch (name) {
    case "smbd":     return "com.apple.smbd";
    case "anpan-os": return LAUNCHD_LABEL;
    default:         return name;
  }
}

export class LaunchdServiceProvider implements ServiceProvider {
  readonly id    = "launchd" as const;
  readonly label = "launchd";

  readonly capabilities: ServiceCapabilities = {
    // launchd has no reload verb — a restart is the only way to re-read configuration.
    reload:       false,
    powerControl: true,
  };

  /**
   * Running, and loaded at boot.
   *
   * launchd has no "enabled" in systemd's sense: a job is either bootstrapped into a domain
   * or it is not. Being listed at all is the closest honest mapping, and `pgrep` answers
   * "running" more reliably than parsing `print` output, whose format Apple has changed.
   */
  async state(name: string): Promise<ServiceState> {
    const label = labelFor(name);
    const [running, loaded] = await Promise.all([
      Bun.$`pgrep -x ${name}`.quiet().nothrow(),
      Bun.$`launchctl print system/${label}`.quiet().nothrow(),
    ]);

    // Exclude ourselves. `anpan-os --doctor` asking about the anpan-os service is a name
    // match against its own process, which would report the daemon as running whether or
    // not it is — precisely inverting the question the caller asked.
    const pids = running.stdout.toString().trim().split(/\s+/)
      .map(Number)
      .filter(n => Number.isInteger(n) && n > 0 && n !== process.pid);

    return {
      active:  pids.length > 0,
      enabled: loaded.exitCode === 0,
      pid:     pids[0] ?? null,
    };
  }

  async restart(name: string): Promise<boolean> {
    const launchctl = await commands.which("launchctl");
    if (!launchctl) return false;
    // kickstart -k kills the running instance and starts a new one in a single step, so
    // there is no window in which the job is unloaded.
    const res = await Bun.$`${launchctl} kickstart -k system/${labelFor(name)}`.quiet().nothrow();
    return res.exitCode === 0;
  }

  /** No reload verb exists, so this is a restart. capabilities.reload says as much. */
  async reload(name: string): Promise<boolean> {
    return this.restart(name);
  }

  /**
   * Restart anpan-os itself.
   *
   * kickstart rather than unload-then-load: the latter would have this process tear down
   * the job it is running inside, and the HTTP response would never be flushed.
   */
  restartSelfCommand(): string[] { return ["launchctl", "kickstart", "-k", `system/${LAUNCHD_LABEL}`]; }
  rebootCommand():      string[] { return ["shutdown", "-r", "now"]; }
  poweroffCommand():    string[] { return ["shutdown", "-h", "now"]; }
}
