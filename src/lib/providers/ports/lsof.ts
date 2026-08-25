/**
 * macOS ports, via `lsof`.
 *
 * macOS has no iproute2, so `ss` does not exist. lsof reports the same facts — bound
 * address, port, owning process and pid — and ships with every macOS install.
 */

import { commands } from "../../commands";
import type { Listener, PortProvider } from "./types";

/**
 * Parse `lsof -F` field output.
 *
 * -F asks for machine-readable output rather than columns: one field per line, tagged by a
 * leading character, with process-level fields (p=pid, c=command) preceding the file-level
 * lines (n=name) they apply to. Worth the extra parsing because the human-readable NAME
 * column is genuinely ambiguous — a command containing spaces cannot be split from its
 * arguments reliably.
 *
 * Names look like "*:8080", "127.0.0.1:5000", or "[::1]:631" for IPv6.
 */
export function parseLsof(raw: string, proto: string): Listener[] {
  const entries: Listener[] = [];
  let pid: number | null = null;
  let command = "";

  for (const line of raw.split("\n")) {
    const tag  = line[0];
    const rest = line.slice(1);

    if (tag === "p") { pid = parseInt(rest, 10) || null; continue; }
    if (tag === "c") { command = rest; continue; }
    if (tag !== "n") continue;

    // An established connection is not a listener. UDP rows never contain "->".
    if (rest.includes("->")) continue;

    // IPv6 addresses are bracketed, so the port is after the last colon in both forms.
    const lastColon = rest.lastIndexOf(":");
    if (lastColon < 0) continue;
    const port = parseInt(rest.slice(lastColon + 1), 10);
    if (isNaN(port) || port <= 0) continue;

    entries.push({
      port,
      proto,
      address: rest.slice(0, lastColon).replace(/^\[|\]$/g, "") || "*",
      process: command,
      pid,
    });
  }
  return entries;
}

export class LsofPortProvider implements PortProvider {
  readonly id = "lsof" as const;

  async listeners(): Promise<Listener[]> {
    const lsof = await commands.which("lsof");
    if (!lsof) return [];
    // -sTCP:LISTEN filters TCP to listeners; UDP sockets have no such state, so every
    // bound UDP socket is reported and the "->" check in the parser drops connected ones.
    const [tcp, udp] = await Promise.all([
      Bun.$`${lsof} -nP -iTCP -sTCP:LISTEN -FpcnPL`.quiet().nothrow(),
      Bun.$`${lsof} -nP -iUDP -FpcnPL`.quiet().nothrow(),
    ]);
    return [
      ...parseLsof(tcp.stdout.toString(), "tcp"),
      ...parseLsof(udp.stdout.toString(), "udp"),
    ];
  }
}
