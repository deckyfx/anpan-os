import { Elysia, t } from "elysia";
import { join }      from "node:path";
import { authGuard } from "./authGuard";
import { bins, commands } from "../lib/commands";
import { IS_LINUX }  from "../lib/platform";
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

interface Listener { port: number; address: string; process: string; pid: number | null; proto: string }

/**
 * Parse `lsof -nP -iTCP -sTCP:LISTEN -FpcnPL` field output into port entries.
 *
 * macOS has no iproute2, so `ss` does not exist there. lsof reports the same facts — bound
 * address, port, owning process and pid — and is present on every macOS install.
 *
 * -F asks for machine-readable output instead of columns: one field per line, tagged by a
 * leading character, with process-level fields (p=pid, c=command) preceding the file-level
 * lines (n=name) they apply to. That is worth the extra parsing because the human-readable
 * NAME column is genuinely ambiguous — a command containing spaces cannot be split apart
 * from its arguments reliably.
 *
 * Names look like "*:8080", "127.0.0.1:5000", or "[::1]:631" for IPv6.
 */
function parseLsofOutput(raw: string, proto: string): Listener[] {
  const entries: Listener[] = [];
  let pid: number | null = null;
  let command = "";

  for (const line of raw.split("\n")) {
    const tag  = line[0];
    const rest = line.slice(1);

    if (tag === "p") { pid = parseInt(rest, 10) || null; continue; }
    if (tag === "c") { command = rest; continue; }
    if (tag !== "n") continue;

    // UDP rows have no "->"; skip established TCP connections, which are not listeners.
    if (rest.includes("->")) continue;

    // IPv6 addresses are bracketed, so the port is after the last colon in both forms.
    const lastColon = rest.lastIndexOf(":");
    if (lastColon < 0) continue;
    const port = parseInt(rest.slice(lastColon + 1), 10);
    if (isNaN(port) || port <= 0) continue;

    const address = rest.slice(0, lastColon).replace(/^\[|\]$/g, "") || "*";
    entries.push({ port, address, process: command, pid, proto });
  }

  return entries;
}

/**
 * Every listening socket on the host.
 *
 * `ss` is preferred on Linux: it reads /proc/net directly and is markedly faster than lsof,
 * which stats every open file descriptor on the system. macOS has only lsof.
 */
async function listListeners(): Promise<Listener[]> {
  if (IS_LINUX) {
    const [tcp, udp] = await Promise.all([
      Bun.$`${bins.ss ?? "ss"} -Htlnp`.quiet().nothrow(),
      Bun.$`${bins.ss ?? "ss"} -Htunp`.quiet().nothrow(),
    ]);
    return [
      ...parseSsOutput(tcp.stdout.toString()).map(e => ({ ...e, proto: "tcp" })),
      ...parseSsOutput(udp.stdout.toString()).map(e => ({ ...e, proto: "udp" })),
    ];
  }

  const lsof = bins.lsof ?? "lsof";
  // -sTCP:LISTEN filters to listeners; UDP sockets have no such state, so every bound
  // UDP socket is reported and the "->" check in the parser drops the connected ones.
  const [tcp, udp] = await Promise.all([
    Bun.$`${lsof} -nP -iTCP -sTCP:LISTEN -FpcnPL`.quiet().nothrow(),
    Bun.$`${lsof} -nP -iUDP -FpcnPL`.quiet().nothrow(),
  ]);
  return [
    ...parseLsofOutput(tcp.stdout.toString(), "tcp"),
    ...parseLsofOutput(udp.stdout.toString(), "udp"),
  ];
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
      const allEntries = await listListeners();

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
