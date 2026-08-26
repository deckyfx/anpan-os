/**
 * Service provider — starting, stopping and inspecting system services.
 *
 * systemd and launchd disagree about nearly everything. launchd has no "enabled" separate
 * from "loaded", no reload verb, reports state through `print` rather than `is-active`, and
 * addresses jobs by domain-qualified label rather than unit name. Power control differs too:
 * `systemctl poweroff` versus `shutdown -h now`.
 *
 * The installers already carry a shell version of this same abstraction (the svc_* helpers),
 * which is the clearest sign it belongs behind an interface here as well.
 */

export interface ServiceState {
  /** The service is running now. */
  active:  boolean;
  /** It is configured to start at boot. */
  enabled: boolean;
  /**
   * Process id of the running service, where the manager will say.
   *
   * Null when it is not running, or when the manager reports state without a pid. Never
   * the id of the process doing the asking: anpan-os can ask about its own service, and a
   * name match against itself would report "running" for a daemon that is not.
   */
  pid:     number | null;
}

export interface ServiceCapabilities {
  /** Whether the manager can reload a service's config without restarting it. */
  reload:       boolean;
  /** Whether this manager can power the host down or reboot it. */
  powerControl: boolean;
}

export interface ServiceProvider {
  readonly id:    "systemd" | "launchd";
  readonly label: string;
  readonly capabilities: ServiceCapabilities;

  /**
   * Whether a service is running and enabled.
   *
   * `name` is the plain service name — "smbd", "anpan-os". Each implementation maps it to
   * whatever its manager expects, so callers never spell out a unit file or a launchd label.
   */
  state(name: string): Promise<ServiceState>;

  restart(name: string): Promise<boolean>;
  /** Reload config in place where supported, else restart. */
  reload(name: string): Promise<boolean>;

  /** Argv that restarts anpan-os itself, or null where we cannot. */
  restartSelfCommand(): string[] | null;
  rebootCommand():      string[] | null;
  poweroffCommand():    string[] | null;
}
