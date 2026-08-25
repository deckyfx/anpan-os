import { IS_LINUX } from "../../platform";
import { LsofPortProvider } from "./lsof";
import { SsPortProvider }   from "./ss";
import type { PortProvider } from "./types";

export * from "./types";
export { SsPortProvider, LsofPortProvider };

/** The port scanner for this host. */
export const ports: PortProvider = IS_LINUX ? new SsPortProvider() : new LsofPortProvider();
