/** Linux services, via systemd. */

import { commands } from "../../commands";
import type { ServiceCapabilities, ServiceProvider, ServiceState } from "./types";

export class SystemdServiceProvider implements ServiceProvider {
  readonly id    = "systemd" as const;
  readonly label = "systemd";

  readonly capabilities: ServiceCapabilities = {
    reload:       true,
    powerControl: true,
  };

  async state(name: string): Promise<ServiceState> {
    const systemctl = await commands.which("systemctl");
    if (!systemctl) return { active: false, enabled: false, pid: null };
    const [active, enabled, mainPid] = await Promise.all([
      Bun.$`${systemctl} is-active ${name}`.quiet().nothrow(),
      Bun.$`${systemctl} is-enabled ${name}`.quiet().nothrow(),
      // systemd knows the unit's main process, so there is no name matching to get wrong.
      Bun.$`${systemctl} show -p MainPID --value ${name}`.quiet().nothrow(),
    ]);
    const pid = parseInt(mainPid.stdout.toString().trim(), 10);
    return {
      active:  active.stdout.toString().trim()  === "active",
      enabled: enabled.stdout.toString().trim() === "enabled",
      // systemd reports 0 for "no main process".
      pid:     Number.isInteger(pid) && pid > 0 ? pid : null,
    };
  }

  async restart(name: string): Promise<boolean> {
    const systemctl = await commands.which("systemctl");
    if (!systemctl) return false;
    return (await Bun.$`${systemctl} restart ${name}`.quiet().nothrow()).exitCode === 0;
  }

  async reload(name: string): Promise<boolean> {
    const systemctl = await commands.which("systemctl");
    if (!systemctl) return false;
    return (await Bun.$`${systemctl} reload ${name}`.quiet().nothrow()).exitCode === 0;
  }

  restartSelfCommand(): string[] { return ["systemctl", "restart", "anpan-os"]; }
  rebootCommand():      string[] { return ["systemctl", "reboot"]; }
  poweroffCommand():    string[] { return ["systemctl", "poweroff"]; }
}
