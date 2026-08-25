import { IS_LINUX } from "../../platform";
import { LaunchdServiceProvider } from "./launchd";
import { SystemdServiceProvider } from "./systemd";
import type { ServiceProvider }   from "./types";

export * from "./types";
export { SystemdServiceProvider, LaunchdServiceProvider };

/** The service manager for this host. */
export const service: ServiceProvider = IS_LINUX
  ? new SystemdServiceProvider()
  : new LaunchdServiceProvider();
