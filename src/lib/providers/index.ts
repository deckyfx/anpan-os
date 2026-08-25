/**
 * Providers — every place the host OS genuinely changes the implementation.
 *
 * Four things qualify: publishing a share, managing a service, listing listening ports, and
 * reading system metrics. Each has a different mechanism per platform, not merely a
 * different binary name.
 *
 * Deliberately not here: zip, unzip, rsync, ffmpeg, cp, mv, du and docker. Those are the
 * same command with the same flags on both platforms, so wrapping them would add a layer
 * that removes no decision. What they need is a check that they are installed at all, which
 * lib/commands provides.
 */

export { shareProvider, requireShareProvider, resetShareProvider } from "./shares";
export { service } from "./service";
export { ports }   from "./ports";
export { metrics } from "./metrics";

export type { ShareProvider }   from "./shares";
export type { ServiceProvider } from "./service";
export type { PortProvider }    from "./ports";
export type { MetricsProvider } from "./metrics";
