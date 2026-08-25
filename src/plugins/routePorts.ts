import { Elysia, t } from "elysia";
import { join }      from "node:path";
import { authGuard } from "./authGuard";
import { commands } from "../lib/commands";
import { ports as portProvider } from "../lib/providers";
import { envConfig } from "../env-config";

export interface PortEntry {
  id:        string; // stable composite key: "<address>:<port>/<proto>"
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
  const file = Bun.file(notesPath());
  if (!(await file.exists())) return {};
  const text = await file.text();
  return JSON.parse(text) as NotesMap;
}

async function writeNotes(notes: NotesMap): Promise<void> {
  await Bun.write(notesPath(), JSON.stringify(notes, null, 2));
}

/**
 * Parse `docker ps --format '{{.Names}}\t{{.Ports}}'` into a map from "port/proto" → container name.
 *
 * Port bindings look like: 0.0.0.0:80->80/tcp, 0.0.0.0:443->443/tcp
 */
function parseDockerPorts(raw: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of raw.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const name  = line.slice(0, tab).trim();
    const ports = line.slice(tab + 1).trim();
    for (const binding of ports.split(",")) {
      // Match "host-addr:port->container-port/proto"  e.g. "0.0.0.0:80->80/tcp"
      const m = binding.trim().match(/:(\d+)->[\d:]+\/(tcp|udp)/i);
      if (m) map.set(`${m[1]}/${m[2]!.toLowerCase()}`, name);
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
      // 1. Listening TCP/UDP sockets — ss on Linux, lsof on macOS
      const allEntries = await portProvider.listeners();

      // Deduplicate by port+proto
      const seen = new Set<string>();
      const unique = allEntries.filter(e => {
        const key = `${e.port}/${e.proto}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      // 2. Docker port bindings — enrichment only. A host without Docker still has ports
      // worth listing, so its absence annotates nothing rather than failing the scan.
      const docker = await commands.which("docker");
      const containerByPort = docker
        ? parseDockerPorts(
            (await Bun.$`${docker} ps --format ${"{{.Names}}\t{{.Ports}}"}`.quiet().nothrow())
              .stdout.toString(),
          )
        : new Map<string, string>();

      // 3. Load notes
      const notes = await readNotes();

      // 4. Merge
      const ports: PortEntry[] = unique
        .sort((a, b) => a.port - b.port)
        .map(e => ({
          id:        `${e.address}:${e.port}/${e.proto}`,
          port:      e.port,
          proto:     e.proto,
          address:   e.address,
          process:   e.process,
          pid:       e.pid,
          container: containerByPort.get(`${e.port}/${e.proto}`) ?? null,
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
