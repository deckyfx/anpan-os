import { IS_LINUX } from "../../platform";
import { DarwinMetricsProvider } from "./darwin";
import { LinuxMetricsProvider }  from "./linux";
import type { MetricsProvider }  from "./types";

export * from "./types";
export { LinuxMetricsProvider, DarwinMetricsProvider };

/**
 * The metrics source for this host.
 *
 * Resolved once: the OS does not change while the process runs. Anything that is not
 * Linux is read the macOS way — the only other platform this ships for.
 */
export const metrics: MetricsProvider = IS_LINUX
  ? new LinuxMetricsProvider()
  : new DarwinMetricsProvider();
