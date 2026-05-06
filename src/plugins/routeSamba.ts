import { Elysia, t } from "elysia";
import { authGuard } from "./authGuard";
import { config } from "../config";
import { bins } from "../lib/commands";

// ─── Types ────────────────────────────────────────────────────────────────────

interface SambaShare {
  name:      string;
  path:      string;
  comment:   string;
  readOnly:  boolean;
  browseable: boolean;
}

// ─── smb.conf parser ─────────────────────────────────────────────────────────

/** Split smb.conf into {global: string, shares: SambaShare[]}. */
function parseConf(raw: string): { global: string; shares: SambaShare[] } {
  const lines  = raw.split("\n");
  const shares: SambaShare[] = [];

  // Collect the [global] section as raw text — never touched.
  let globalLines: string[] = [];
  let inGlobal = false;

  // Current share being accumulated.
  let current: Partial<SambaShare> | null = null;

  function flush() {
    if (current?.name) {
      shares.push({
        name:       current.name,
        path:       current.path ?? "",
        comment:    current.comment ?? "",
        readOnly:   current.readOnly ?? false,
        browseable: current.browseable ?? true,
      });
    }
    current = null;
  }

  for (const line of lines) {
    const trimmed = line.trim();
    const sectionMatch = trimmed.match(/^\[(.+)\]$/);

    if (sectionMatch) {
      const sectionName = sectionMatch[1]!;

      if (sectionName.toLowerCase() === "global") {
        flush();
        inGlobal = true;
        globalLines.push(line);
        continue;
      }

      // Non-global section — flush previous share and start new one.
      flush();
      inGlobal  = false;
      current   = { name: sectionName };
      continue;
    }

    if (inGlobal) {
      globalLines.push(line);
      continue;
    }

    if (current) {
      const kvMatch = trimmed.match(/^([^=]+?)\s*=\s*(.*)$/);
      if (kvMatch) {
        const key = kvMatch[1]!.trim().toLowerCase().replace(/\s+/g, " ");
        const val = kvMatch[2]!.trim();
        switch (key) {
          case "path":        current.path       = val; break;
          case "comment":     current.comment    = val; break;
          case "read only":   current.readOnly   = val.toLowerCase() === "yes"; break;
          case "browseable":  current.browseable = val.toLowerCase() !== "no";  break;
        }
      }
    }
  }

  flush();

  // Trim trailing empty lines from global section but preserve a terminating newline.
  const globalStr = globalLines.join("\n");
  return { global: globalStr, shares };
}

/** Serialise shares back to smb.conf text. */
function sharesToConf(shares: SambaShare[]): string {
  return shares.map((s) => [
    `[${s.name}]`,
    `   path = ${s.path}`,
    `   comment = ${s.comment}`,
    `   read only = ${s.readOnly ? "yes" : "no"}`,
    `   browseable = ${s.browseable ? "yes" : "no"}`,
  ].join("\n")).join("\n\n");
}

/** Read, parse, modify, write smb.conf atomically. */
async function readConf(): Promise<{ global: string; shares: SambaShare[] }> {
  const file = Bun.file(config.sambaConfigPath);
  if (!(await file.exists())) return { global: "", shares: [] };
  return parseConf(await file.text());
}

async function writeConf(globalSection: string, shares: SambaShare[]): Promise<void> {
  const parts: string[] = [];
  if (globalSection) parts.push(globalSection);
  const shareText = sharesToConf(shares);
  if (shareText) parts.push(shareText);
  await Bun.write(config.sambaConfigPath, parts.join("\n\n") + "\n");
}

// ─── Plugin ───────────────────────────────────────────────────────────────────

export function sambaPlugin(jwtSecret: string) {
  return new Elysia({ prefix: "/api/samba" })
    .use(authGuard(jwtSecret))

    // GET /api/samba/shares
    .get("/shares", async () => {
      try {
        const { shares } = await readConf();
        return shares;
      } catch {
        return Response.json({ error: "Failed to read samba config" }, { status: 500 });
      }
    })

    // POST /api/samba/shares
    .post("/shares", async ({ body }) => {
      try {
        const { global: globalSection, shares } = await readConf();

        if (shares.some((s) => s.name.toLowerCase() === body.name.toLowerCase())) {
          return Response.json({ error: "Share name already exists" }, { status: 409 });
        }

        shares.push({
          name:       body.name,
          path:       body.path,
          comment:    body.comment ?? "",
          readOnly:   body.readOnly ?? false,
          browseable: true,
        });

        await writeConf(globalSection, shares);
        return { ok: true };
      } catch {
        return Response.json({ error: "Failed to update samba config" }, { status: 500 });
      }
    }, {
      body: t.Object({
        name:     t.String({ minLength: 1 }),
        path:     t.String({ minLength: 1 }),
        comment:  t.Optional(t.String()),
        readOnly: t.Optional(t.Boolean()),
      }),
    })

    // DELETE /api/samba/shares/:name
    .delete("/shares/:name", async ({ params }) => {
      try {
        const { global: globalSection, shares } = await readConf();
        const filtered = shares.filter(
          (s) => s.name.toLowerCase() !== params.name.toLowerCase()
        );

        if (filtered.length === shares.length) {
          return Response.json({ error: "Share not found" }, { status: 404 });
        }

        await writeConf(globalSection, filtered);
        return { ok: true };
      } catch {
        return Response.json({ error: "Failed to update samba config" }, { status: 500 });
      }
    })

    // POST /api/samba/reload
    .post("/reload", async () => {
      try {
        await Bun.$`${bins.systemctl} reload smbd`.quiet();
        return { ok: true };
      } catch {
        return Response.json({ error: "Failed to reload smbd" }, { status: 500 });
      }
    });
}
