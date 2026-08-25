/**
 * Port provider — what is listening on this host.
 *
 * Linux and macOS answer this with different tools reporting different formats: `ss` reads
 * /proc/net directly, while macOS has no iproute2 at all and lsof must walk every open file
 * descriptor on the system. Same question, no shared implementation.
 */

export interface Listener {
  port:    number;
  proto:   string;
  address: string;
  process: string;
  pid:     number | null;
}

export interface PortProvider {
  readonly id: "ss" | "lsof";
  /** Every listening TCP and UDP socket. Empty when the tool is unavailable. */
  listeners(): Promise<Listener[]>;
}
