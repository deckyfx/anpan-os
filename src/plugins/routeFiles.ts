import { Elysia, t, sse } from "elysia";
import { resolve, join, basename, extname } from "node:path";
import { readdir, stat, mkdir, rename, rm, chmod, chown } from "node:fs/promises";
import { homedir } from "node:os";
import { authGuard } from "./authGuard";
import { config } from "../config";
import { bins, commands } from "../lib/commands";
import { StreamAggregator, drainStream } from "../lib/sse";
import type { SSEMsg } from "../lib/sse";
import { SettingsStore } from "../stores/settings-store";

// ─── Types ────────────────────────────────────────────────────────────────────

interface FileEntry {
  name:     string;
  path:     string;
  isDir:    boolean;
  size:     number;
  modified: number;
  ext:      string;
  mode:     string; // octal string e.g. "755"
  uid:      number;
  gid:      number;
}

// ─── Path security ────────────────────────────────────────────────────────────

/** Resolve inputPath and verify it stays within config.filesRoot. */
function guardPath(inputPath: string): string {
  const root     = config.filesRoot;
  const resolved = resolve(inputPath);

  if (root === "/") return resolved;

  const normalRoot = root.endsWith("/") ? root.slice(0, -1) : root;
  if (resolved !== normalRoot && !resolved.startsWith(`${normalRoot}/`)) {
    throw new Error("Forbidden");
  }
  return resolved;
}

/**
 * Legacy `x-` media types Bun reports, mapped to their registered equivalents.
 *
 * Browsers vary in how forgiving they are: Firefox will not decode `audio/x-flac` at all,
 * so a perfectly playable file is rejected before the decoder ever sees it. The registered
 * names (audio/flac is RFC 9639) are understood everywhere.
 */
const CANONICAL_MIME: Record<string, string> = {
  "audio/x-flac": "audio/flac",
  "audio/x-wav":  "audio/wav",
  "audio/x-m4a":  "audio/mp4",
  "audio/x-aac":  "audio/aac",
};

function canonicalMime(type: string): string {
  return CANONICAL_MIME[type] ?? type;
}

/**
 * Percent-encode a string for an RFC 5987 ext-value, as used by `filename*`.
 *
 * encodeURIComponent is close but not sufficient: it leaves ' ( ) * unescaped, and none of
 * those are in RFC 5987's attr-char set. A client that validates strictly discards the
 * whole filename* and falls back to the ASCII filename, which for a name like
 * "Album (2026).flac" means losing the parenthesised part of a perfectly ordinary title.
 */
function rfc5987(value: string): string {
  return encodeURIComponent(value)
    .replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function forbidden()   { return Response.json({ error: "Access denied" },     { status: 403 }); }
function notFound()    { return Response.json({ error: "Not found" },          { status: 404 }); }
function tooLarge()    { return Response.json({ error: "File too large" },     { status: 413 }); }
function serverError() { return Response.json({ error: "Internal server error" }, { status: 500 }); }

// ─── Binary detection ─────────────────────────────────────────────────────────

/**
 * Peek the first 8 KB and decide whether the content is binary.
 * Rules (same heuristic used by git and GNU file):
 *   1. Any null byte  → binary
 *   2. >30 % non-printable bytes (outside tab/LF/CR/space-~) → binary
 */
function isBinaryContent(bytes: Uint8Array): boolean {
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0) return true;
  }
  if (bytes.length === 0) return false;
  let nonText = 0;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    if ((b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) || b > 0x7e) nonText++;
  }
  return nonText / bytes.length > 0.30;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function listDir(dirPath: string): Promise<FileEntry[]> {
  const names = await readdir(dirPath);
  const entries: FileEntry[] = [];

  for (const name of names) {
    const full = join(dirPath, name);
    try {
      const s   = await stat(full);
      const ext = s.isDirectory() ? "" : extname(name).slice(1).toLowerCase();
      entries.push({
        name,
        path:     full,
        isDir:    s.isDirectory(),
        size:     s.isDirectory() ? 0 : s.size,
        modified: s.mtimeMs,
        ext,
        mode:     (s.mode & 0o777).toString(8).padStart(3, "0"),
        uid:      s.uid,
        gid:      s.gid,
      });
    } catch {
      // Skip entries that can't be stat'd (broken symlinks, permission errors, etc.)
    }
  }

  return entries;
}

// ─── Plugin ───────────────────────────────────────────────────────────────────

export function filesPlugin(jwtSecret: string) {
  return new Elysia({ prefix: "/api/files" })
    .use(authGuard(jwtSecret))

    // GET /api/files/list?path=
    .get("/list", async ({ query }) => {
      let resolved: string;
      try { resolved = guardPath(query.path); } catch { return forbidden(); }
      try {
        return await listDir(resolved);
      } catch {
        return notFound();
      }
    }, { query: t.Object({ path: t.String() }) })

    // GET /api/files/read?path=
    // Returns { content, binary } — client uses `binary` to decide UI,
    // no extension whitelist needed.
    .get("/read", async ({ query }) => {
      let resolved: string;
      try { resolved = guardPath(query.path); } catch { return forbidden(); }
      try {
        const file = Bun.file(resolved);
        if (!(await file.exists())) return notFound();

        // Peek first 8 KB to detect binary without reading the whole file
        const peekSize = Math.min(file.size, 8192);
        const peek = new Uint8Array(await file.slice(0, peekSize).arrayBuffer());
        if (isBinaryContent(peek)) return { content: "", binary: true };

        // Text file — enforce a 2 MB read limit
        if (file.size > 2_097_152) return tooLarge();
        return { content: await file.text(), binary: false };
      } catch {
        return serverError();
      }
    }, { query: t.Object({ path: t.String() }) })

    // PUT /api/files/write
    .put("/write", async ({ body }) => {
      let resolved: string;
      try { resolved = guardPath(body.path); } catch { return forbidden(); }
      try {
        await Bun.write(resolved, body.content);
        return { ok: true };
      } catch {
        return serverError();
      }
    }, { body: t.Object({ path: t.String(), content: t.String() }) })

    // POST /api/files/mkdir
    .post("/mkdir", async ({ body }) => {
      let resolved: string;
      try { resolved = guardPath(body.path); } catch { return forbidden(); }
      try {
        await mkdir(resolved, { recursive: true });
        return { ok: true };
      } catch {
        return serverError();
      }
    }, { body: t.Object({ path: t.String() }) })

    // DELETE /api/files/delete
    .delete("/delete", async ({ body }) => {
      let resolved: string;
      try { resolved = guardPath(body.path); } catch { return forbidden(); }
      try {
        await rm(resolved, { recursive: false });
        return { ok: true };
      } catch {
        return serverError();
      }
    }, { body: t.Object({ path: t.String() }) })

    // POST /api/files/rename
    .post("/rename", async ({ body }) => {
      let from: string, to: string;
      try {
        from = guardPath(body.from);
        to   = guardPath(body.to);
      } catch { return forbidden(); }
      try {
        await rename(from, to);
        return { ok: true };
      } catch {
        return serverError();
      }
    }, { body: t.Object({ from: t.String(), to: t.String() }) })

    // GET /api/files/download?path=
    // Range is served explicitly rather than left to Bun's implicit handling of
    // file-backed responses. That implicit path works for a route defined in isolation,
    // but not once the route is inside this plugin: the response arrives without
    // Content-Length or Accept-Ranges, and a Range request is answered 200 with the whole
    // body. A media element treats such a resource as non-seekable, so audio and video
    // previews would play but refuse to scrub.
    .get("/download", async ({ query, request, set }) => {
      let resolved: string;
      try { resolved = guardPath(query.path); } catch { return forbidden(); }
      const file = Bun.file(resolved);
      if (!(await file.exists())) return notFound();

      const size = file.size;
      const type = canonicalMime(file.type || "application/octet-stream");
      // The preview asks for inline; "attachment" tells the browser to save rather than
      // render, which is right for the Download action and wrong for a <video> or <audio>.
      // RFC 6266 filename* carries the UTF-8 name, since filename="" is ASCII-only and
      // these are frequently not ASCII at all.
      const name = basename(resolved);
      // filename="" is a header value, so it must stay printable ASCII — a raw name like
      // "01 ベリーグッド.flac" makes the whole response throw, which surfaced as a 500 on
      // both preview and download for every non-ASCII filename. The readable name travels
      // in filename* instead, which is defined as UTF-8 and which every current browser
      // prefers when both are present.
      const asciiName = name.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");
      const disposition =
        `${query.inline === "1" ? "inline" : "attachment"}; `
        + `filename="${asciiName}"; `
        + `filename*=UTF-8''${rfc5987(name)}`;
      const range = request.headers.get("range");

      // Only "bytes=start-end" is honoured; multi-range requests are rare and no browser
      // needs them for media playback, so anything else falls through to the full body.
      const match = range?.match(/^bytes=(\d*)-(\d*)$/);
      if (match) {
        const [, rawStart, rawEnd] = match;
        // "bytes=-500" means the final 500 bytes, not a range starting at zero.
        const suffix = rawStart === "";
        const start  = suffix ? Math.max(0, size - Number(rawEnd)) : Number(rawStart);
        const end    = suffix || rawEnd === "" ? size - 1 : Math.min(Number(rawEnd), size - 1);

        if (!Number.isFinite(start) || start >= size || start > end) {
          set.status = 416;
          set.headers["content-range"] = `bytes */${size}`;
          return "Range Not Satisfiable";
        }

        // A client may ask for the whole remainder ("bytes=0-"). Serving fewer bytes than
        // requested is allowed as long as Content-Range describes what was actually sent,
        // so the chunk is capped to keep an open-ended range off the heap.
        const MAX_CHUNK = 8 * 1024 * 1024;
        const cappedEnd = Math.min(end, start + MAX_CHUNK - 1);

        // Read the slice into memory rather than handing back a lazy file slice: passing a
        // sliced BunFile through this plugin yields a body that honours the start offset
        // but streams to EOF, so the response would contradict its own Content-Range.
        const chunk = await file.slice(start, cappedEnd + 1).arrayBuffer();

        return new Response(chunk, {
          status: 206,
          headers: {
            "Content-Range":       `bytes ${start}-${cappedEnd}/${size}`,
            "Content-Length":      String(chunk.byteLength),
            "Accept-Ranges":       "bytes",
            "Content-Disposition": disposition,
            "Content-Type":        type,
          },
        });
      }

      return new Response(file, {
        headers: {
          // Advertise range support, or the browser will not offer a seek bar at all.
          "Accept-Ranges":       "bytes",
          "Content-Length":      String(size),
          "Content-Disposition": disposition,
          "Content-Type":        type,
        },
      });
    }, { query: t.Object({ path: t.String(), inline: t.Optional(t.String()) }) })

    // POST /api/files/upload?path=
    .post("/upload", async ({ query, body }) => {
      let dir: string;
      try { dir = guardPath(query.path); } catch { return forbidden(); }
      try {
        const file = body.file as File;
        const dest = guardPath(`${dir}/${file.name}`);
        await Bun.write(dest, file);
        return { ok: true };
      } catch {
        return serverError();
      }
    }, {
      query: t.Object({ path: t.String() }),
      body:  t.Object({ file: t.File() }),
    })

    // POST /api/files/chmod
    .post("/chmod", async ({ body, set }) => {
      let resolved: string;
      try { resolved = guardPath(body.path); } catch { return forbidden(); }
      const mode = parseInt(body.mode, 8);
      if (isNaN(mode) || mode < 0 || mode > 0o777) {
        set.status = 400;
        return { error: "Invalid mode" };
      }
      try {
        if (body.recursive) {
          const proc = Bun.spawn(["chmod", "-R", body.mode, resolved], { stderr: "pipe" });
          const exitCode = await proc.exited;
          if (exitCode !== 0) {
            const errText = await new Response(proc.stderr).text();
            set.status = 500;
            return { error: errText.trim() || "chmod -R failed" };
          }
        } else {
          await chmod(resolved, mode);
        }
        return { ok: true };
      } catch (e) {
        set.status = 500;
        return { error: e instanceof Error ? e.message : "chmod failed" };
      }
    }, { body: t.Object({ path: t.String(), mode: t.String(), recursive: t.Optional(t.Boolean()) }) })

    // POST /api/files/chown
    .post("/chown", async ({ body, set }) => {
      let resolved: string;
      try { resolved = guardPath(body.path); } catch { return forbidden(); }

      const resolveId = (value: string, kind: "user" | "group"): number | null => {
        const n = parseInt(value, 10);
        if (!isNaN(n) && String(n) === value.trim()) return n;
        const flag = kind === "user" ? "-u" : "-g";
        const proc = Bun.spawnSync(["id", flag, value.trim()]);
        if (proc.exitCode !== 0) return null;
        const parsed = parseInt(proc.stdout.toString().trim(), 10);
        return isNaN(parsed) ? null : parsed;
      };

      const uid = resolveId(body.owner, "user");
      const gid = resolveId(body.group, "group");

      if (uid === null) { set.status = 400; return { error: `Unknown user: ${body.owner}` }; }
      if (gid === null) { set.status = 400; return { error: `Unknown group: ${body.group}` }; }

      try {
        if (body.recursive) {
          const proc = Bun.spawn(["chown", "-R", `${uid}:${gid}`, resolved], { stderr: "pipe" });
          const exitCode = await proc.exited;
          if (exitCode !== 0) {
            const errText = await new Response(proc.stderr).text();
            set.status = 500;
            return { error: errText.trim() || "chown -R failed" };
          }
        } else {
          await chown(resolved, uid, gid);
        }
        return { ok: true };
      } catch (e) {
        set.status = 500;
        return { error: e instanceof Error ? e.message : "chown failed" };
      }
    }, { body: t.Object({ path: t.String(), owner: t.String(), group: t.String(), recursive: t.Optional(t.Boolean()) }) })

    // POST /api/files/zip
    .post("/zip", async ({ body }) => {
      let dest: string;
      let paths: string[];
      try {
        dest  = guardPath(body.dest);
        paths = body.paths.map((p) => guardPath(p));
      } catch { return forbidden(); }
      try {
        await Bun.$`${bins.zip} -r ${dest} ${paths}`.quiet();
        return { ok: true };
      } catch {
        return serverError();
      }
    }, { body: t.Object({ paths: t.Array(t.String()), dest: t.String() }) })

    // POST /api/files/unzip
    .post("/unzip", async ({ body }) => {
      let src: string, dest: string;
      try {
        src  = guardPath(body.path);
        dest = guardPath(body.dest);
      } catch { return forbidden(); }
      try {
        await Bun.$`${bins.unzip} -o ${src} -d ${dest}`.quiet();
        return { ok: true };
      } catch {
        return serverError();
      }
    }, { body: t.Object({ path: t.String(), dest: t.String() }) })

    // GET /api/files/home — return homedir if within filesRoot, else filesRoot
    .get("/home", () => {
      try {
        const guarded = guardPath(homedir());
        return { path: guarded };
      } catch {
        return { path: config.filesRoot };
      }
    })

    // POST /api/files/copy — SSE streaming copy (rsync or cp fallback)
    .post(
      "/copy",
      async function*({ body }) {
        let sources: string[];
        let destination: string;
        try {
          sources     = body.sources.map(guardPath);
          destination = guardPath(body.destination);
        } catch {
          yield sse({ data: { error: "Access denied" } satisfies SSEMsg });
          return;
        }

        const agg = new StreamAggregator();
        const hasRsync = await commands.isAvailable("rsync");

        void (async () => {
          try {
            for (const src of sources) {
              const args = hasRsync && bins.rsync
                ? [bins.rsync, "-av", src, destination]
                : [bins.cp ?? "cp", "-rv", src, destination];
              const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
              await Promise.all([
                drainStream(proc.stdout, data => agg.push(data)),
                drainStream(proc.stderr, data => agg.push(data)),
              ]);
              const code = await proc.exited;
              if (code !== 0) {
                await agg.push({ error: `Copy failed with exit code ${code}` });
                agg.end();
                return;
              }
            }
            await agg.push({ ok: true });
          } catch (err) {
            await agg.push({ error: err instanceof Error ? err.message : String(err) });
          } finally {
            agg.end();
          }
        })();

        for await (const msg of agg) yield sse({ data: msg });
      },
      { body: t.Object({ sources: t.Array(t.String()), destination: t.String() }) },
    )

    // POST /api/files/move — SSE streaming move (same-device: mv; cross-device: rsync/cp+rm)
    .post(
      "/move",
      async function*({ body }) {
        let sources: string[];
        let destination: string;
        try {
          sources     = body.sources.map(guardPath);
          destination = guardPath(body.destination);
        } catch {
          yield sse({ data: { error: "Access denied" } satisfies SSEMsg });
          return;
        }

        const agg = new StreamAggregator();

        void (async () => {
          try {
            for (const src of sources) {
              const [srcStat, destStat] = await Promise.all([
                stat(src).catch(() => null),
                stat(destination).catch(() => null),
              ]);

              const sameDev = srcStat && destStat && srcStat.dev === destStat.dev;

              if (sameDev && bins.mv) {
                // Same device — instant atomic move
                const proc = Bun.spawn([bins.mv, "-v", src, destination], { stdout: "pipe", stderr: "pipe" });
                await Promise.all([
                  drainStream(proc.stdout, data => agg.push(data)),
                  drainStream(proc.stderr, data => agg.push(data)),
                ]);
                const code = await proc.exited;
                if (code !== 0) {
                  await agg.push({ error: `Move failed with exit code ${code}` });
                  agg.end();
                  return;
                }
              } else {
                // Cross-device — rsync --remove-source-files, or cp + rm fallback
                const hasRsync = await commands.isAvailable("rsync");
                if (hasRsync && bins.rsync) {
                  const proc = Bun.spawn([bins.rsync, "-av", "--remove-source-files", src, destination], { stdout: "pipe", stderr: "pipe" });
                  await Promise.all([
                    drainStream(proc.stdout, data => agg.push(data)),
                    drainStream(proc.stderr, data => agg.push(data)),
                  ]);
                  const code = await proc.exited;
                  if (code !== 0) {
                    await agg.push({ error: `Move failed with exit code ${code}` });
                    agg.end();
                    return;
                  }
                  // rsync --remove-source-files leaves empty directories behind; clean them up.
                  try {
                    await rm(src, { recursive: true });
                    await agg.push({ log: `Removed source: ${src}` });
                  } catch (cleanErr) {
                    await agg.push({ error: `Move succeeded but source cleanup failed: ${cleanErr instanceof Error ? cleanErr.message : String(cleanErr)}` });
                    agg.end();
                    return;
                  }
                } else {
                  // cp then rm fallback
                  const cpArgs = [bins.cp ?? "cp", "-rv", src, destination];
                  const cpProc = Bun.spawn(cpArgs, { stdout: "pipe", stderr: "pipe" });
                  await Promise.all([
                    drainStream(cpProc.stdout, data => agg.push(data)),
                    drainStream(cpProc.stderr, data => agg.push(data)),
                  ]);
                  const cpCode = await cpProc.exited;
                  if (cpCode !== 0) {
                    await agg.push({ error: `Copy phase failed with exit code ${cpCode}` });
                    agg.end();
                    return;
                  }
                  await rm(src, { recursive: true });
                  await agg.push({ log: `Removed source: ${src}` });
                }
              }
            }
            await agg.push({ ok: true });
          } catch (err) {
            await agg.push({ error: err instanceof Error ? err.message : String(err) });
          } finally {
            agg.end();
          }
        })();

        for await (const msg of agg) yield sse({ data: msg });
      },
      { body: t.Object({ sources: t.Array(t.String()), destination: t.String() }) },
    )

    // GET /api/files/size?path= — folder/file size via du
    .get(
      "/size",
      async ({ query, set }) => {
        let resolved: string;
        try { resolved = guardPath(query.path); } catch { return forbidden(); }
        if (!bins.du) {
          set.status = 501;
          return { error: "du not available on this system" };
        }
        try {
          const proc = Bun.spawn([bins.du, "-sh", resolved], { stdout: "pipe", stderr: "pipe" });
          const [out, errText, exitCode] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
            proc.exited,
          ]);
          if (exitCode !== 0) {
            set.status = 500;
            return { error: errText.trim() || `du exited with code ${exitCode}` };
          }
          // du -sh output: "1.5G\t/path"
          const size = out.split("\t")[0]?.trim() ?? "unknown";
          return { size };
        } catch (e) {
          set.status = 500;
          return { error: e instanceof Error ? e.message : "Failed to calculate size" };
        }
      },
      { query: t.Object({ path: t.String() }) },
    )

    // GET /api/files/config — returns file browser configuration
    .get("/config", async () => {
      const [startPath, persistRaw, lastPath, bookmarksRaw] = await Promise.all([
        SettingsStore.get("files_start_path"),
        SettingsStore.get("files_persist_last_path"),
        SettingsStore.get("files_last_path"),
        SettingsStore.get("files_bookmarks"),
      ]);

      let bookmarks: { name: string; path: string }[] = [];
      try {
        const parsed: unknown = JSON.parse(bookmarksRaw ?? "[]");
        if (Array.isArray(parsed)) {
          bookmarks = parsed.filter(
            (item): item is { name: string; path: string } =>
              typeof item?.name === "string" && typeof item?.path === "string",
          );
        }
      } catch {
        bookmarks = [];
      }

      return {
        startPath:       startPath       ?? "",
        persistLastPath: (persistRaw     ?? "0") === "1",
        lastPath:        lastPath        ?? "",
        bookmarks,
      };
    })

    // PATCH /api/files/config — update file browser configuration (all fields optional)
    .patch("/config", async ({ body, set: s }) => {
      const tasks: Promise<void>[] = [];

      if (body.startPath !== undefined) {
        // Empty string resets to default — only validate non-empty paths.
        if (body.startPath !== "") {
          try { guardPath(body.startPath); } catch { s.status = 400; return { error: "startPath is outside the allowed root" }; }
        }
        tasks.push(SettingsStore.set("files_start_path", body.startPath));
      }
      if (body.persistLastPath !== undefined) {
        tasks.push(SettingsStore.set("files_persist_last_path", body.persistLastPath ? "1" : "0"));
      }
      if (body.lastPath !== undefined) {
        if (body.lastPath !== "") {
          try { guardPath(body.lastPath); } catch { s.status = 400; return { error: "lastPath is outside the allowed root" }; }
        }
        tasks.push(SettingsStore.set("files_last_path", body.lastPath));
      }
      if (body.bookmarks !== undefined) {
        for (const bm of body.bookmarks) {
          try { guardPath(bm.path); } catch { s.status = 400; return { error: `Bookmark path "${bm.path}" is outside the allowed root` }; }
        }
        tasks.push(SettingsStore.set("files_bookmarks", JSON.stringify(body.bookmarks)));
      }

      await Promise.all(tasks);
      return { ok: true };
    }, {
      body: t.Object({
        startPath:       t.Optional(t.String()),
        persistLastPath: t.Optional(t.Boolean()),
        lastPath:        t.Optional(t.String()),
        bookmarks:       t.Optional(t.Array(t.Object({
          name: t.String(),
          path: t.String(),
        }))),
      }),
    });
}
