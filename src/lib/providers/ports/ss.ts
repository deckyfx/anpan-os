/**
 * Linux ports, via `ss`.
 *
 * Preferred over lsof where it exists: it reads /proc/net directly and is markedly faster
 * than stat-ing every file descriptor on the system.
 */

import { commands } from "../../commands";
import type { Listener, PortProvider } from "./types";

/**
 * Parse `ss -Htlnp` / `ss -Htunp` output.
 *
 * A line looks like:
 *   LISTEN  0  128  0.0.0.0:22  0.0.0.0:*  users:(("sshd",pid=1234,fd=3))
 */
export function parseSs(raw: string, proto: string): Listener[] {
  const entries: Listener[] = [];
  for (const line of raw.split("\n")) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5) continue;

    const local = cols[3] ?? "";
    // "addr:port" — the port is after the last colon, which holds for IPv6 too.
    const lastColon = local.lastIndexOf(":");
    if (lastColon < 0) continue;
    const port = parseInt(local.slice(lastColon + 1), 10);
    if (isNaN(port) || port <= 0) continue;

    const usersCol    = cols.slice(5).join(" ");
    const nameMatch   = usersCol.match(/"\(([^"]+)"\)|"([^"]+)"/);
    const pidMatch    = usersCol.match(/pid=(\d+)/);

    entries.push({
      port,
      proto,
      address: local.slice(0, lastColon) || "*",
      process: nameMatch ? (nameMatch[1] ?? nameMatch[2] ?? "") : "",
      pid:     pidMatch ? parseInt(pidMatch[1]!, 10) : null,
    });
  }
  return entries;
}

export class SsPortProvider implements PortProvider {
  readonly id = "ss" as const;

  async listeners(): Promise<Listener[]> {
    const ss = await commands.which("ss");
    if (!ss) return [];
    const [tcp, udp] = await Promise.all([
      Bun.$`${ss} -Htlnp`.quiet().nothrow(),
      Bun.$`${ss} -Htunp`.quiet().nothrow(),
    ]);
    return [
      ...parseSs(tcp.stdout.toString(), "tcp"),
      ...parseSs(udp.stdout.toString(), "udp"),
    ];
  }
}
