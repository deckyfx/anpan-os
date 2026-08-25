import { Elysia, t, sse } from "elysia";
import { resolve, join, basename, extname } from "node:path";
import { readdir, stat, mkdir, rename, rm, chmod, chown } from "node:fs/promises";
import { homedir } from "node:os";
import { authGuard } from "./authGuard";
import { config } from "../config";
import { bins, commands } from "../lib/commands";
import { parseFile } from "music-metadata";
import NodeID3 from "node-id3";
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

/** Image types embedded artwork may be served as. Anything else is not rendered as such. */
const ART_MIME = new Set([
  "image/jpeg", "image/png", "image/gif", "image/webp", "image/bmp", "image/avif",
]);

// ─── Online metadata lookup ───────────────────────────────────────────────────

/** A track suggestion from an external catalogue. */
interface LookupCandidate {
  title:  string;
  artist: string;
  album:  string;
  genre:  string | null;
  year:   string | null;
  artworkUrl: string | null;
  source: "itunes" | "musicbrainz";
}

/** Neither service is load-bearing, so a slow one must not hold a request open. */
const LOOKUP_TIMEOUT_MS = 8_000;

interface ItunesTrack {
  trackName?:        string;
  artistName?:       string;
  collectionName?:   string;
  primaryGenreName?: string;
  releaseDate?:      string;
  artworkUrl100?:    string;
}

async function lookupItunes(q: string, limit = 5): Promise<LookupCandidate[]> {
  // No country parameter: results should follow the caller's query, not a locale this
  // server happens to be configured with.
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(q)}&media=music&limit=${limit}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS) });
    if (!res.ok) return [];
    const data = await res.json() as { results?: ItunesTrack[] };
    return (data.results ?? [])
      .filter(r => r.trackName && r.artistName)
      .map(r => ({
        title:  r.trackName!,
        artist: r.artistName!,
        album:  r.collectionName ?? r.trackName!,
        genre:  r.primaryGenreName ?? null,
        year:   r.releaseDate?.slice(0, 4) ?? null,
        // The 100px thumbnail URL yields a usable cover by substitution; iTunes serves the
        // larger size from the same path.
        artworkUrl: r.artworkUrl100?.replace("100x100bb", "600x600bb") ?? null,
        source: "itunes" as const,
      }));
  } catch {
    return [];   // offline, blocked, or timed out — the caller falls through
  }
}

interface MBRecording {
  title?: string;
  "artist-credit"?: Array<{ artist?: { name?: string } }>;
  releases?: Array<{ title?: string; date?: string }>;
}

async function lookupMusicBrainz(q: string, limit = 5): Promise<LookupCandidate[]> {
  const url = `https://musicbrainz.org/ws/2/recording/?query=${encodeURIComponent(q)}&fmt=json&limit=${limit}`;
  try {
    const res = await fetch(url, {
      // MusicBrainz requires a User-Agent identifying the application and a contact URL;
      // requests without one are rejected or throttled.
      headers: { "User-Agent": `anpan-os/${process.env.APP_VERSION ?? "dev"} ( https://github.com/deckyfx/anpan-os )` },
      signal:  AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
    });
    if (!res.ok) return [];
    const data = await res.json() as { recordings?: MBRecording[] };
    return (data.recordings ?? [])
      .filter(r => r.title)
      .map(r => ({
        title:  r.title!,
        artist: r["artist-credit"]?.[0]?.artist?.name ?? "",
        album:  r.releases?.[0]?.title ?? r.title!,
        genre:  null,
        year:   r.releases?.[0]?.date?.slice(0, 4) ?? null,
        // Cover Art Archive would need a second round trip per candidate; left for the
        // user to supply rather than firing N more external requests per search.
        artworkUrl: null,
        source: "musicbrainz" as const,
      }));
  } catch {
    return [];
  }
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
    .post("/zip", async ({ body, set }) => {
      let dest: string;
      let paths: string[];
      try {
        dest  = guardPath(body.dest);
        paths = body.paths.map((p) => guardPath(p));
      } catch { return forbidden(); }
      // zip ships with macOS and most Linux distros, but "most" is not "all" — a slim
      // container image has neither, and a raw "command not found" is not an answer.
      const zip = await commands.which("zip");
      if (!zip) { set.status = 503; return { error: "zip is not installed — see System Doctor" }; }
      try {
        await Bun.$`${zip} -r ${dest} ${paths}`.quiet();
        return { ok: true };
      } catch {
        return serverError();
      }
    }, { body: t.Object({ paths: t.Array(t.String()), dest: t.String() }) })

    // POST /api/files/unzip
    .post("/unzip", async ({ body, set }) => {
      let src: string, dest: string;
      try {
        src  = guardPath(body.path);
        dest = guardPath(body.dest);
      } catch { return forbidden(); }
      const unzip = await commands.which("unzip");
      if (!unzip) { set.status = 503; return { error: "unzip is not installed — see System Doctor" }; }
      try {
        await Bun.$`${unzip} -o ${src} -d ${dest}`.quiet();
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

    /**
     * GET /api/files/audio-meta?path= — tags and technical detail for one audio file.
     *
     * Cover art is deliberately excluded and served by /audio-art instead: embedded art
     * routinely runs to hundreds of kilobytes, and base64 in JSON would inflate it by a
     * third and make it uncacheable.
     */
    .get("/audio-meta", async ({ query }) => {
      let resolved: string;
      try { resolved = guardPath(query.path); } catch { return forbidden(); }
      if (!(await Bun.file(resolved).exists())) return notFound();

      let parsed: Awaited<ReturnType<typeof parseFile>>;
      try {
        parsed = await parseFile(resolved);
      } catch {
        // An unreadable or non-audio file is an expected outcome here, not a fault.
        return Response.json({ error: "Could not read audio metadata" }, { status: 422 });
      }

      const { common, format } = parsed;
      return {
        title:    common.title  ?? null,
        artist:   common.artist ?? null,
        album:    common.album  ?? null,
        albumArtist: common.albumartist ?? null,
        genre:    common.genre?.[0] ?? null,
        year:     common.year   ?? null,
        track:    common.track?.no ?? null,
        trackOf:  common.track?.of ?? null,
        container:  format.container  ?? null,
        codec:      format.codec      ?? null,
        bitrate:    format.bitrate    ? Math.round(format.bitrate) : null,
        sampleRate: format.sampleRate ?? null,
        bitsPerSample: format.bitsPerSample ?? null,
        channels:   format.numberOfChannels ?? null,
        duration:   format.duration   ?? null,
        lossless:   format.lossless   ?? null,
        hasArt:     (parsed.common.picture?.length ?? 0) > 0,
      };
    }, { query: t.Object({ path: t.String() }) })

    /** GET /api/files/audio-art?path= — the first embedded cover image, as raw bytes. */
    .get("/audio-art", async ({ query }) => {
      let resolved: string;
      try { resolved = guardPath(query.path); } catch { return forbidden(); }
      if (!(await Bun.file(resolved).exists())) return notFound();

      let pic: { format: string; data: Uint8Array } | undefined;
      try {
        pic = (await parseFile(resolved)).common.picture?.[0];
      } catch {
        return notFound();
      }
      if (!pic) return notFound();

      return new Response(new Uint8Array(pic.data), {
        headers: {
          // pic.format is data from inside the file, so a crafted track could declare
          // text/html and — on a same-origin, cookie-authenticated route — have it
          // rendered as markup in the app's own origin. Anything unrecognised is served
          // as a generic binary, and nosniff stops the browser second-guessing that.
          "Content-Type":  ART_MIME.has(pic.format) ? pic.format : "application/octet-stream",
          "X-Content-Type-Options": "nosniff",
          "Content-Length": String(pic.data.length),
          // Private: this is the user's own library, not something a shared proxy may hold.
          "Cache-Control": "private, max-age=300",
        },
      });
    }, { query: t.Object({ path: t.String() }) })

    /**
     * POST /api/files/audio-tags-copy — copy tags from one audio file onto an MP3.
     *
     * Artwork is included, unlike the online lookup: both paths are local and already
     * constrained by guardPath, so there is no request to a caller-supplied address here.
     */
    .post("/audio-tags-copy", async ({ body }) => {
      let from: string, to: string;
      try {
        from = guardPath(body.from);
        to   = guardPath(body.to);
      } catch { return forbidden(); }

      if (extname(to).toLowerCase() !== ".mp3") {
        return Response.json({ error: "Tags can only be written to MP3 files" }, { status: 422 });
      }
      if (from === to) {
        return Response.json({ error: "Source and destination are the same file" }, { status: 422 });
      }
      if (!(await Bun.file(from).exists()) || !(await Bun.file(to).exists())) return notFound();

      let parsed: Awaited<ReturnType<typeof parseFile>>;
      try {
        parsed = await parseFile(from);
      } catch {
        return Response.json({ error: "Could not read tags from the source file" }, { status: 422 });
      }

      const { common } = parsed;
      const tags: Record<string, unknown> = {};
      if (common.title)  tags.title  = common.title;
      if (common.artist) tags.artist = common.artist;
      if (common.album)  tags.album  = common.album;
      if (common.genre?.[0]) tags.genre = common.genre[0];
      if (common.year)   tags.year   = String(common.year);

      const pic = common.picture?.[0];
      if (pic) {
        tags.image = {
          mime: pic.format,
          type: { id: 3, name: "front cover" },
          description: pic.description ?? "",
          imageBuffer: Buffer.from(pic.data),
        };
      }

      // Track number is deliberately excluded: it identifies a position within an album,
      // so copying it from another track is nearly always wrong.
      if (Object.keys(tags).length === 0) {
        return Response.json({ error: "The source file has no tags to copy" }, { status: 422 });
      }

      try {
        const result = NodeID3.update(tags, to);
        if (result !== true) {
          return Response.json(
            { error: result instanceof Error ? result.message : "Failed to write tags" },
            { status: 500 },
          );
        }
      } catch (err) {
        return Response.json(
          { error: err instanceof Error ? err.message : "Failed to write tags" },
          { status: 500 },
        );
      }

      return { ok: true, copied: Object.keys(tags) };
    }, { body: t.Object({ from: t.String(), to: t.String() }) })

    /**
     * GET /api/files/audio-lookup?q= — candidate track metadata from iTunes, then
     * MusicBrainz if iTunes returns nothing.
     *
     * Gated on files.metadata_lookup. This is the only route in anpan-os that sends user
     * data to a third party — the query describes what is in someone's library — so it
     * stays off until explicitly enabled rather than degrading quietly.
     */
    .get("/audio-lookup", async ({ query }) => {
      if (!config.metadataLookupEnabled) {
        return Response.json(
          { error: "Online metadata lookup is disabled. Set files.metadata_lookup = true in config.toml." },
          { status: 403 },
        );
      }

      const q = query.q.trim();
      if (!q) return Response.json({ error: "Empty query" }, { status: 422 });

      const candidates = await lookupItunes(q);
      if (candidates.length > 0) return { candidates, source: "itunes" };

      const fallback = await lookupMusicBrainz(q);
      return { candidates: fallback, source: "musicbrainz" };
    }, { query: t.Object({ q: t.String() }) })

    /**
     * POST /api/files/audio-tags — write ID3 tags to an MP3.
     *
     * MP3 only: node-id3 writes ID3 frames, which is not the tagging format FLAC or MP4
     * use. Editing those would mean remuxing through ffmpeg — a whole-file rewrite to
     * change one string — so they are refused here rather than silently mishandled.
     *
     * Uses update() rather than write(): update merges into the existing tag, so frames
     * this UI does not expose — embedded art above all — survive an edit instead of being
     * dropped on the first save.
     */
    .post("/audio-tags", async ({ body }) => {
      let resolved: string;
      try { resolved = guardPath(body.path); } catch { return forbidden(); }

      if (extname(resolved).toLowerCase() !== ".mp3") {
        return Response.json({ error: "Only MP3 files can be tagged" }, { status: 422 });
      }
      if (!(await Bun.file(resolved).exists())) return notFound();

      // Undefined leaves a frame untouched; empty string clears it. Without this
      // distinction a UI that omits a field would silently wipe it.
      const tags: Record<string, string> = {};
      for (const key of ["title", "artist", "album", "genre", "year", "trackNumber"] as const) {
        const value = body[key];
        if (value !== undefined) tags[key] = value;
      }

      if (Object.keys(tags).length === 0) {
        return Response.json({ error: "No tags supplied" }, { status: 422 });
      }

      try {
        const result = NodeID3.update(tags, resolved);
        if (result !== true) {
          return Response.json(
            { error: result instanceof Error ? result.message : "Failed to write tags" },
            { status: 500 },
          );
        }
      } catch (err) {
        return Response.json(
          { error: err instanceof Error ? err.message : "Failed to write tags" },
          { status: 500 },
        );
      }

      return { ok: true };
    }, {
      body: t.Object({
        path:        t.String(),
        title:       t.Optional(t.String()),
        artist:      t.Optional(t.String()),
        album:       t.Optional(t.String()),
        genre:       t.Optional(t.String()),
        year:        t.Optional(t.String()),
        trackNumber: t.Optional(t.String()),
      }),
    })

    /**
     * POST /api/files/convert-folder — SSE streaming conversion of every FLAC in a folder.
     *
     * Non-recursive: an album is one directory, and walking deeper would quietly turn
     * "convert this album" into "convert this entire library".
     *
     * Files whose .mp3 already exists are skipped rather than treated as failures, so
     * re-running after an interruption resumes instead of redoing the work.
     */
    .post(
      "/convert-folder",
      async function*({ body, request }) {
        let dir: string;
        try { dir = guardPath(body.path); } catch {
          yield sse({ data: { error: "Access denied" } satisfies SSEMsg });
          return;
        }

        const ffmpeg = bins.ffmpeg;
        if (!ffmpeg) {
          yield sse({ data: { error: "ffmpeg is not installed — see System Doctor" } satisfies SSEMsg });
          return;
        }

        let names: string[];
        try {
          names = await readdir(dir);
        } catch {
          yield sse({ data: { error: "Could not read folder" } satisfies SSEMsg });
          return;
        }

        const flacs = names.filter(n => extname(n).toLowerCase() === ".flac").sort();
        if (flacs.length === 0) {
          yield sse({ data: { error: "No FLAC files in this folder" } satisfies SSEMsg });
          return;
        }

        const agg = new StreamAggregator();
        let current: Bun.Subprocess | null = null;
        let aborted = false;

        request.signal.addEventListener("abort", () => {
          aborted = true;
          current?.kill();
          agg.end();
        }, { once: true });

        void (async () => {
          let converted = 0, skipped = 0;
          try {
            for (const [i, name] of flacs.entries()) {
              if (aborted) return;

              const source = join(dir, name);
              const target = source.slice(0, -extname(source).length) + ".mp3";

              if (await Bun.file(target).exists()) {
                skipped++;
                await agg.push({ log: `Skipped ${name} — .mp3 already exists` });
                // Progress tracks files handled, not audio decoded: per-file percentages
                // would keep resetting and tell the user nothing about the album.
                await agg.push({ progress: Math.round(((i + 1) / flacs.length) * 100) });
                continue;
              }

              await agg.push({ log: `Converting ${name}…` });
              const proc = Bun.spawn(
                [ffmpeg, "-hide_banner", "-nostdin", "-y", "-loglevel", "error",
                 "-i", source, "-b:a", "320k", "-map_metadata", "0", target],
                { stdout: "pipe", stderr: "pipe" },
              );
              current = proc;

              await Promise.all([
                drainStream(proc.stdout, data => agg.push(data)),
                drainStream(proc.stderr, data => agg.push(data)),
              ]);
              const code = await proc.exited;
              current = null;

              if (aborted) return;
              if (code !== 0) {
                await agg.push({ error: `ffmpeg failed on ${name} (exit ${code})` });
                return;
              }

              converted++;
              await agg.push({ progress: Math.round(((i + 1) / flacs.length) * 100) });
            }

            await agg.push({ log: `Done — ${converted} converted, ${skipped} skipped` });
            await agg.push({ ok: true });
          } catch (err) {
            await agg.push({ error: err instanceof Error ? err.message : String(err) });
          } finally {
            agg.end();
          }
        })();

        for await (const msg of agg) yield sse({ data: msg });
      },
      { body: t.Object({ path: t.String() }) },
    )

    /**
     * POST /api/files/convert — SSE streaming FLAC → MP3 at 320k CBR.
     *
     * `-map_metadata 0` carries the FLAC's Vorbis comments over to ID3, so a converted
     * track does not arrive untagged. Progress is read from `-progress pipe:1`, which is
     * newline-delimited key=value; ffmpeg's default stats go to stderr separated by
     * carriage returns, which a line-oriented reader would buffer into one enormous line.
     */
    .post(
      "/convert",
      async function*({ body, request }) {
        let source: string;
        try { source = guardPath(body.path); } catch {
          yield sse({ data: { error: "Access denied" } satisfies SSEMsg });
          return;
        }

        if (extname(source).toLowerCase() !== ".flac") {
          yield sse({ data: { error: "Only FLAC files can be converted" } satisfies SSEMsg });
          return;
        }

        const ffmpeg = bins.ffmpeg;
        if (!ffmpeg) {
          yield sse({ data: { error: "ffmpeg is not installed — see System Doctor" } satisfies SSEMsg });
          return;
        }

        const src = Bun.file(source);
        if (!(await src.exists())) {
          yield sse({ data: { error: "Source file no longer exists" } satisfies SSEMsg });
          return;
        }

        const target = source.slice(0, -extname(source).length) + ".mp3";
        if (!body.overwrite && await Bun.file(target).exists()) {
          yield sse({ data: {
            error:    `${basename(target)} already exists.`,
            conflict: true,
          } satisfies SSEMsg });
          return;
        }

        const agg = new StreamAggregator();
        const proc = Bun.spawn(
          [
            ffmpeg, "-hide_banner", "-nostdin", "-y",
            "-i", source,
            "-b:a", "320k", "-map_metadata", "0",
            "-nostats", "-progress", "pipe:1",
            target,
          ],
          { stdout: "pipe", stderr: "pipe" },
        );

        // Without this a client that closes the tab leaves ffmpeg transcoding to completion
        // with nothing consuming its output — and once the aggregator's buffer fills, the
        // producers suspend forever and the subprocess is never reaped.
        request.signal.addEventListener("abort", () => { proc.kill(); agg.end(); }, { once: true });

        void (async () => {
          let totalUs = 0;
          let lastPct = -1;
          try {
            await Promise.all([
              // stdout: progress key=value pairs
              drainStream(proc.stdout, async data => {
                const line = data.log ?? "";
                const us = line.match(/^out_time_us=(\d+)/)?.[1];
                if (us && totalUs > 0) {
                  const pct = Math.min(99, Math.floor((Number(us) / totalUs) * 100));
                  // Emit only on change: ffmpeg reports several times a second and every
                  // duplicate costs a frame the client has to render.
                  if (pct !== lastPct) {
                    lastPct = pct;
                    await agg.push({ progress: pct });
                  }
                }
              }),
              // stderr: banner, the Duration line, and any real error
              drainStream(proc.stderr, async data => {
                const line = data.log ?? "";
                const d = line.match(/Duration:\s*(\d+):(\d\d):(\d\d)\.(\d+)/);
                if (d) {
                  const [, h, m, s, cs] = d;
                  totalUs = ((Number(h) * 3600 + Number(m) * 60 + Number(s)) * 100 + Number(cs)) * 10_000;
                }
                await agg.push({ log: line });
              }),
            ]);

            const code = await proc.exited;
            if (code !== 0) {
              await agg.push({ error: `ffmpeg exited with code ${code}` });
            } else {
              await agg.push({ progress: 100 });
              await agg.push({ log: `Wrote ${basename(target)}` });
              await agg.push({ ok: true });
            }
          } catch (err) {
            await agg.push({ error: err instanceof Error ? err.message : String(err) });
          } finally {
            agg.end();
          }
        })();

        for await (const msg of agg) yield sse({ data: msg });
      },
      { body: t.Object({ path: t.String(), overwrite: t.Optional(t.Boolean()) }) },
    )

    // POST /api/files/copy — SSE streaming copy (rsync or cp fallback)
    .post(
      "/copy",
      async function*({ body, request }) {
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

        // A closed tab used to leave rsync running with nothing consuming its output.
        // The copy loop spawns one process per source, so the listener kills whichever is
        // current rather than a single captured handle.
        //
        // Registered before the first await, and seeded from signal.aborted: a listener
        // added after the client has already gone never fires, so a disconnect during the
        // rsync availability check below would otherwise start the copy anyway.
        let current: Bun.Subprocess | null = null;
        let aborted = request.signal.aborted;
        request.signal.addEventListener("abort", () => {
          aborted = true;
          current?.kill();
          agg.end();
        }, { once: true });

        // Already gone before we began: returning here avoids holding the generator open
        // for an availability probe whose result nothing will use.
        if (aborted) { agg.end(); return; }

        const hasRsync = await commands.isAvailable("rsync");
        // The probe is awaited, so the client may have gone during it.
        if (aborted) { agg.end(); return; }

        void (async () => {
          try {
            for (const src of sources) {
              if (aborted) return;
              const args = hasRsync && bins.rsync
                ? [bins.rsync, "-av", src, destination]
                : [bins.cp ?? "cp", "-rv", src, destination];
              const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
              current = proc;
              await Promise.all([
                drainStream(proc.stdout, data => agg.push(data)),
                drainStream(proc.stderr, data => agg.push(data)),
              ]);
              const code = await proc.exited;
              current = null;
              if (aborted) return;
              if (code !== 0) {
                await agg.push({ error: `Copy failed with exit code ${code}` });
                agg.end();
                return;
              }
            }
            // Checked here as well as in the loop: an empty sources array never enters
            // the loop, so without this an aborted request would still report success.
            if (!aborted) await agg.push({ ok: true });
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
      async function*({ body, request }) {
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

        // The move loop spawns up to three different processes per source — mv on the
        // same device, otherwise rsync or cp followed by a remove — so the listener kills
        // whichever is current rather than one captured handle.
        // Seeded from signal.aborted for the same reason as copy: a listener added after
        // the client has gone never fires.
        let current: Bun.Subprocess | null = null;
        let aborted = request.signal.aborted;
        request.signal.addEventListener("abort", () => {
          aborted = true;
          current?.kill();
          agg.end();
        }, { once: true });

        // Already gone before the worker starts — matches the copy path.
        if (aborted) { agg.end(); return; }

        void (async () => {
          try {
            for (const src of sources) {
              if (aborted) return;
              const [srcStat, destStat] = await Promise.all([
                stat(src).catch(() => null),
                stat(destination).catch(() => null),
              ]);

              const sameDev = srcStat && destStat && srcStat.dev === destStat.dev;

              // `current` is null while stat() above is pending, so an abort during it
              // leaves nothing to kill — the guard has to be here, not only in the listener.
              if (aborted) return;

              if (sameDev && bins.mv) {
                // Same device — instant atomic move
                const proc = Bun.spawn([bins.mv, "-v", src, destination], { stdout: "pipe", stderr: "pipe" });
                current = proc;
                await Promise.all([
                  drainStream(proc.stdout, data => agg.push(data)),
                  drainStream(proc.stderr, data => agg.push(data)),
                ]);
                const code = await proc.exited;
                current = null;
                if (aborted) return;
                if (code !== 0) {
                  await agg.push({ error: `Move failed with exit code ${code}` });
                  agg.end();
                  return;
                }
              } else {
                // Cross-device — rsync --remove-source-files, or cp + rm fallback
                const hasRsync = await commands.isAvailable("rsync");
                if (hasRsync && bins.rsync) {
                  if (aborted) return;
                  const proc = Bun.spawn([bins.rsync, "-av", "--remove-source-files", src, destination], { stdout: "pipe", stderr: "pipe" });
                  current = proc;
                  await Promise.all([
                    drainStream(proc.stdout, data => agg.push(data)),
                    drainStream(proc.stderr, data => agg.push(data)),
                  ]);
                  const code = await proc.exited;
                current = null;
                if (aborted) return;
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
                  if (aborted) return;
                  const cpProc = Bun.spawn(cpArgs, { stdout: "pipe", stderr: "pipe" });
                  current = cpProc;
                  await Promise.all([
                    drainStream(cpProc.stdout, data => agg.push(data)),
                    drainStream(cpProc.stderr, data => agg.push(data)),
                  ]);
                  const cpCode = await cpProc.exited;
                  current = null;
                  if (aborted) return;
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
            // Checked here as well as in the loop: an empty sources array never enters
            // the loop, so without this an aborted request would still report success.
            if (!aborted) await agg.push({ ok: true });
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
