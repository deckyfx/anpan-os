import { Elysia, t } from "elysia";
import { join }      from "node:path";
import { authGuard } from "./authGuard";
import { bins }      from "../lib/commands";
import { envConfig } from "../env-config";

export interface PortEntry {
  port:      number;
  proto:     string;
  address:   string;
  process:   string;
  pid:       number | null;
  container: string | null;
  note:      string | null;
}

type NotesMap = Record<string, string>; // key = "<port>/<proto>", e.g. "80/tcp"

function notesPath(): string {
  return join(envConfig.RUNTIME_CONFIG_DIR, "port-notes.json");
}

async function readNotes(): Promise<NotesMap> {
  try {
    const text = await Bun.file(notesPath()).text();
    return JSON.parse(text) as NotesMap;
  } catch {
    return {};
  }
}

async function writeNotes(notes: NotesMap): Promise<void> {
  await Bun.write(notesPath(), JSON.stringify(notes, null, 2));
}

/**
 * Parse `ss -Htlnp` output into port entries.
 *
 * Example line:
 *   LISTEN  0  128  0.0.0.0:22  0.0.0.0:*  users:(("sshd",pid=1234,fd=3))
 */
function parseSsOutput(raw: string): Array<{ port: number; address: string; process: string; pid: number | null }> {
  const entries: Array<{ port: number; address: string; process: string; pid: number | null }> = [];
  for (const line of raw.split("\n")) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5) continue;
    const local = cols[3] ?? "";
    // Local address is "addr:port" — port is after the last colon
    const lastColon = local.lastIndexOf(":");
    if (lastColon < 0) continue;
    const portStr = local.slice(lastColon + 1);
    const port    = parseInt(portStr, 10);
    if (isNaN(port) || port <= 0) continue;
    const address = local.slice(0, lastColon) || "*";

    // Process field: users:(("name",pid=NNN,fd=N))
    const usersCol = cols.slice(5).join(" ");
    const nameMatch = usersCol.match(/"\(([^"]+)"\)|"([^"]+)"/);
    const processName = nameMatch ? (nameMatch[1] ?? nameMatch[2] ?? "") : "";
    const pidMatch = usersCol.match(/pid=(\d+)/);
    const pid = pidMatch ? parseInt(pidMatch[1]!, 10) : null;

    entries.push({ port, address, process: processName, pid });
  }
  return entries;
}

/**
 * Parse `docker ps --format '{{.Names}}\t{{.Ports}}'` into a map from host port → container name.
 *
 * Port bindings look like: 0.0.0.0:80->80/tcp, 0.0.0.0:443->443/tcp
 */
function parseDockerPorts(raw: string): Map<number, string> {
  const map = new Map<number, string>();
  for (const line of raw.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const name  = line.slice(0, tab).trim();
    const ports = line.slice(tab + 1).trim();
    for (const binding of ports.split(",")) {
      // Match "host-addr:port->container-port/proto"
      const m = binding.trim().match(/:(\d+)->/);
      if (m) map.set(parseInt(m[1]!, 10), name);
    }
  }
  return map;
}

/**
 * Port scanner routes — all protected by auth guard.
 *
 * GET    /api/ports             — scan listening TCP ports, cross-ref with Docker
 * PUT    /api/ports/notes/:key  — upsert note for a port (key = "<port>/<proto>")
 * DELETE /api/ports/notes/:key  — remove note
 */
export function portsPlugin(jwtSecret: string) {
  return new Elysia({ prefix: "/api/ports" })
    .use(authGuard(jwtSecret))

    .get("/", async ({ set }) => {
      // 1. Get listening TCP/UDP ports from ss
      const ssResult = await Bun.$`ss -Htlnp`.nothrow();
      // Also grab UDP
      const ssUdpResult = await Bun.$`ss -Htunp`.nothrow();
      const tcpEntries = parseSsOutput(ssResult.stdout.toString()).map(e => ({ ...e, proto: "tcp" }));
      const udpEntries = parseSsOutput(ssUdpResult.stdout.toString()).map(e => ({ ...e, proto: "udp" }));
      const allEntries = [...tcpEntries, ...udpEntries];

      // Deduplicate by port+proto
      const seen = new Set<string>();
      const unique = allEntries.filter(e => {
        const key = `${e.port}/${e.proto}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      // 2. Get Docker port bindings
      const dockerResult = await Bun.$`${bins.docker} ps --format ${"{{.Names}}\t{{.Ports}}"}`.nothrow();
      const containerByPort = parseDockerPorts(dockerResult.stdout.toString());

      // 3. Load notes
      const notes = await readNotes();

      // 4. Merge
      const ports: PortEntry[] = unique
        .sort((a, b) => a.port - b.port)
        .map(e => ({
          port:      e.port,
          proto:     e.proto,
          address:   e.address,
          process:   e.process,
          pid:       e.pid,
          container: containerByPort.get(e.port) ?? null,
          note:      notes[`${e.port}/${e.proto}`] ?? null,
        }));

      return ports;
    })

    .put(
      "/notes/:key",
      async ({ params, body }) => {
        const notes = await readNotes();
        notes[decodeURIComponent(params.key)] = body.note;
        await writeNotes(notes);
        return { ok: true };
      },
      { body: t.Object({ note: t.String() }) },
    )

    .delete("/notes/:key", async ({ params }) => {
      const notes = await readNotes();
      delete notes[decodeURIComponent(params.key)];
      await writeNotes(notes);
      return { ok: true };
    });
}
