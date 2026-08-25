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
    if (!systemctl) return { active: false, enabled: false };
    const [active, enabled] = await Promise.all([
      Bun.$`${systemctl} is-active ${name}`.quiet().nothrow(),
      Bun.$`${systemctl} is-enabled ${name}`.quiet().nothrow(),
    ]);
    return {
      active:  active.stdout.toString().trim()  === "active",
      enabled: enabled.stdout.toString().trim() === "enabled",
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
