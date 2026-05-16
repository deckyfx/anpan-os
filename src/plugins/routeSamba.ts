import { Elysia, t } from "elysia";
import { mkdirSync } from "node:fs";
import { stat } from "node:fs/promises";
import { authGuard } from "./authGuard";
import { config } from "../config";
import { envConfig } from "../env-config";
import { bins, commands } from "../lib/commands";
import { SambaShareStore } from "../stores/samba-share-store";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SambaShare {
  name:       string;
  path:       string;
  comment:    string;
  readOnly:   boolean;
  browseable: boolean;
  /** "anpan" = managed by anpan-os | "external" = from another config (casaos, etc.) */
  source:     "anpan" | "external";
}

// ─── Share-section parser ─────────────────────────────────────────────────────

/** Parse a conf file that contains only [ShareName] sections (no [global]). */
function parseShares(raw: string, source: SambaShare["source"] = "anpan"): SambaShare[] {
  const shares: SambaShare[]         = [];
  let current:  Partial<SambaShare> | null = null;

  function flush() {
    if (current?.name) {
      shares.push({
        name:       current.name,
        path:       current.path       ?? "",
        comment:    current.comment    ?? "",
        readOnly:   current.readOnly   ?? false,
        browseable: current.browseable ?? true,
        source,
      });
    }
    current = null;
  }

  for (const line of raw.split("\n")) {
    const trimmed    = line.trim();
    const sectionMatch = trimmed.match(/^\[(.+)\]$/);

    if (sectionMatch) {
      const sectionName = sectionMatch[1]!;
      flush();
      if (sectionName.toLowerCase() !== "global") {
        current = { name: sectionName };
      }
      continue;
    }

    if (current) {
      const kv = trimmed.match(/^([^=]+?)\s*=\s*(.*)$/);
      if (kv) {
        const key = kv[1]!.trim().toLowerCase().replace(/\s+/g, " ");
        const val = kv[2]!.trim();
        switch (key) {
          case "path":       current.path       = val; break;
          case "comment":    current.comment    = val; break;
          case "read only":  current.readOnly   = val.toLowerCase() === "yes"; break;
          case "browseable": current.browseable = val.toLowerCase() !== "no";  break;
        }
      }
    }
  }
  flush();
  return shares;
}

/** Serialise an array of shares to conf-file text (no [global]). */
function sharesToConf(shares: SambaShare[]): string {
  return shares.map((s) => [
    `[${s.name}]`,
    `   comment = ${s.comment}`,
    `   path = ${s.path}`,
    `   browseable = ${s.browseable ? "Yes" : "No"}`,
    `   read only = ${s.readOnly ? "Yes" : "No"}`,
    `   guest ok = No`,
    `   create mask = 0644`,
    `   directory mask = 0755`,
  ].join("\n")).join("\n\n");
}

// ─── Our managed config (RUNTIME_CONFIG_DIR/samba.conf) ──────────────────────

async function writeAnpanShares(shares: SambaShare[]): Promise<void> {
  mkdirSync(envConfig.RUNTIME_CONFIG_DIR, { recursive: true });
  const text = sharesToConf(shares);
  await Bun.write(config.sambaSharesPath, text ? text + "\n" : "");
}

/** Rebuild the conf file from SQLite — source of truth. */
async function rebuildConfFromDb(): Promise<void> {
  const rows = await SambaShareStore.findAll();
  const shares: SambaShare[] = rows.map((r) => ({
    name:       r.name,
    path:       r.path,
    comment:    r.comment,
    readOnly:   r.readOnly,
    browseable: r.browseable,
    source:     "anpan",
  }));
  await writeAnpanShares(shares);
}

// ─── System smb.conf include management ──────────────────────────────────────

// Written as a comment line above the include so the path has no inline comment —
// samba's include parser does not strip inline # comments from the path value.
const INCLUDE_MARKER = "# managed by anpan-os";

/** The two-line block we inject into smb.conf (inside an explicit [global] for scope). */
function includeBlock(): string {
  return `[global]\n   ${INCLUDE_MARKER}\n   include = ${config.sambaSharesPath}`;
}

async function readSystemConf(): Promise<string | null> {
  const file = Bun.file(config.smbConfPath);
  if (!(await file.exists())) return null;
  return file.text();
}

/** True if our include line (with the current path) is already present in smb.conf. */
async function isIncludePresent(): Promise<boolean> {
  const raw = await readSystemConf();
  if (!raw) return false;
  return raw.includes(INCLUDE_MARKER) && raw.includes(config.sambaSharesPath);
}

/** Strip all lines belonging to a previous anpan-os block (marker comment + include path). */
function stripAnpanLines(raw: string): string {
  return raw
    .split("\n")
    .filter((l) => !l.includes(INCLUDE_MARKER) && !l.includes(config.sambaSharesPath))
    .join("\n");
}

/**
 * Inject our include block into smb.conf (or update a stale one).
 * Requires root write permission.
 */
async function addIncludeToSystemConf(): Promise<void> {
  const raw = await readSystemConf();
  if (!raw) throw new Error(`${config.smbConfPath} not found`);
  if (await isIncludePresent()) return;
  const cleaned = stripAnpanLines(raw);
  await Bun.write(config.smbConfPath, cleaned.trimEnd() + "\n" + includeBlock() + "\n");
}

/**
 * Remove our include block from smb.conf.
 * Requires root write permission.
 */
async function removeIncludeFromSystemConf(): Promise<void> {
  const raw = await readSystemConf();
  if (!raw) throw new Error(`${config.smbConfPath} not found`);
  if (!raw.includes(INCLUDE_MARKER)) return;
  await Bun.write(config.smbConfPath, stripAnpanLines(raw).trimEnd() + "\n");
}

// ─── Reload smbd ─────────────────────────────────────────────────────────────

async function reloadSmbd(): Promise<void> {
  const hasSmbcontrol = await commands.isAvailable("smbcontrol");
  if (hasSmbcontrol) {
    const proc = Bun.spawn([bins.smbcontrol, "smbd", "reload-config"], { stdout: "pipe", stderr: "pipe" });
    const code = await proc.exited;
    if (code !== 0) throw new Error(`smbcontrol exited ${code}`);
  } else {
    const proc = Bun.spawn([bins.systemctl, "reload", "smbd"], { stdout: "pipe", stderr: "pipe" });
    const code = await proc.exited;
    if (code !== 0) throw new Error(`systemctl reload smbd exited ${code}`);
  }
}

// ─── Aggregate all shares from all included config files ─────────────────────

async function readAllShares(): Promise<SambaShare[]> {
  const rows = await SambaShareStore.findAll();
  const anpan: SambaShare[] = rows.map((r) => ({
    name:       r.name,
    path:       r.path,
    comment:    r.comment,
    readOnly:   r.readOnly,
    browseable: r.browseable,
    source:     "anpan",
  }));

  const rawConf = await readSystemConf();
  const external: SambaShare[] = [];

  if (rawConf) {
    const includePattern = /^[ \t]*include\s*=\s*(.+?)(?:\s*#.*)?$/gm;
    let match: RegExpExecArray | null;
    while ((match = includePattern.exec(rawConf)) !== null) {
      const includePath = match[1]!.trim();
      if (includePath === config.sambaSharesPath) continue;
      try {
        const file = Bun.file(includePath);
        if (await file.exists()) {
          const shares = parseShares(await file.text(), "external");
          external.push(...shares);
        }
      } catch { /* unreadable — skip */ }
    }
  }

  return [...anpan, ...external];
}

// ─── Plugin ───────────────────────────────────────────────────────────────────

export function sambaPlugin(jwtSecret: string) {
  return new Elysia({ prefix: "/api/samba" })
    .use(authGuard(jwtSecret))

    // GET /api/samba/shares — our managed shares (from SQLite)
    .get("/shares", async () => {
      try {
        const rows = await SambaShareStore.findAll();
        return rows.map((r) => ({
          name:       r.name,
          path:       r.path,
          comment:    r.comment,
          readOnly:   r.readOnly,
          browseable: r.browseable,
          source:     "anpan" as const,
        }));
      } catch {
        return Response.json({ error: "Failed to read samba shares" }, { status: 500 });
      }
    })

    // GET /api/samba/all-shares — all shares from all sources
    .get("/all-shares", async () => {
      try {
        return await readAllShares();
      } catch {
        return Response.json({ error: "Failed to read samba config" }, { status: 500 });
      }
    })

    // POST /api/samba/shares — add a new share (writes SQLite + conf file)
    .post("/shares", async ({ body, set }) => {
      try {
        if (!/^[a-zA-Z0-9_\-]+$/.test(body.name)) {
          set.status = 422;
          return { error: "Share name may only contain letters, numbers, hyphens, and underscores" };
        }

        const pathStat = await stat(body.path).catch(() => null);
        if (!pathStat) {
          set.status = 422;
          return { error: "Path does not exist" };
        }
        if (!pathStat.isDirectory()) {
          set.status = 422;
          return { error: "Path is not a directory" };
        }

        const existing = await SambaShareStore.findByName(body.name);
        if (existing) {
          set.status = 409;
          return { error: "Share name already exists" };
        }

        await SambaShareStore.create({
          name:       body.name,
          path:       body.path,
          comment:    body.comment ?? "",
          readOnly:   body.readOnly ?? false,
          browseable: true,
        });

        await rebuildConfFromDb();
        await reloadSmbd().catch(() => { /* smbd may not be running yet */ });
        return { ok: true };
      } catch (e) {
        set.status = 500;
        return { error: e instanceof Error ? e.message : "Failed to update samba config" };
      }
    }, {
      body: t.Object({
        name:     t.String({ minLength: 1 }),
        path:     t.String({ minLength: 1 }),
        comment:  t.Optional(t.String()),
        readOnly: t.Optional(t.Boolean()),
      }),
    })

    // PATCH /api/samba/shares/:name — update an existing share
    .patch("/shares/:name", async ({ params, body, set }) => {
      if (Object.keys(body).length === 0) {
        set.status = 422;
        return { error: "At least one of comment, readOnly, or browseable must be provided" };
      }
      try {
        const updated = await SambaShareStore.updateByName(params.name, body);
        if (!updated) { set.status = 404; return { error: "Share not found" }; }
        await rebuildConfFromDb();
        await reloadSmbd().catch(() => { /* smbd may not be running yet */ });
        return { ok: true };
      } catch (e) {
        set.status = 500;
        return { error: e instanceof Error ? e.message : "Failed to update samba config" };
      }
    }, {
      body: t.Object({
        comment:    t.Optional(t.String()),
        readOnly:   t.Optional(t.Boolean()),
        browseable: t.Optional(t.Boolean()),
      }),
    })

    // DELETE /api/samba/shares/:name
    .delete("/shares/:name", async ({ params, set }) => {
      try {
        const deleted = await SambaShareStore.deleteByName(params.name);
        if (!deleted) { set.status = 404; return { error: "Share not found" }; }
        await rebuildConfFromDb();
        await reloadSmbd().catch(() => { /* smbd may not be running yet */ });
        return { ok: true };
      } catch (e) {
        set.status = 500;
        return { error: e instanceof Error ? e.message : "Failed to update samba config" };
      }
    })

    // GET /api/samba/setup-status
    .get("/setup-status", async () => {
      try {
        const present    = await isIncludePresent();
        const sharesPath = config.sambaSharesPath;
        const smbConf    = config.smbConfPath;
        return { present, sharesPath, smbConf };
      } catch (e) {
        return Response.json({ error: e instanceof Error ? e.message : "Unknown error" }, { status: 500 });
      }
    })

    // POST /api/samba/setup — patch smb.conf to include our shares file
    .post("/setup", async ({ set }) => {
      try {
        await addIncludeToSystemConf();
        return { ok: true };
      } catch (e) {
        set.status = 500;
        return { error: e instanceof Error ? e.message : "Failed to patch smb.conf" };
      }
    })

    // DELETE /api/samba/setup — remove our include directive from smb.conf
    .delete("/setup", async ({ set }) => {
      try {
        await removeIncludeFromSystemConf();
        return { ok: true };
      } catch (e) {
        set.status = 500;
        return { error: e instanceof Error ? e.message : "Failed to unpatch smb.conf" };
      }
    })

    // POST /api/samba/rebuild — rebuild conf file from SQLite
    .post("/rebuild", async ({ set }) => {
      try {
        await rebuildConfFromDb();
        return { ok: true };
      } catch (e) {
        set.status = 500;
        return { error: e instanceof Error ? e.message : "Failed to rebuild samba config" };
      }
    })

    // POST /api/samba/reload — reload smbd
    .post("/reload", async ({ set }) => {
      try {
        await reloadSmbd();
        return { ok: true };
      } catch (e) {
        set.status = 500;
        return { error: e instanceof Error ? e.message : "Failed to reload smbd" };
      }
    });
}
