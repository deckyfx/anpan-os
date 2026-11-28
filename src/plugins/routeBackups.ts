import { Elysia, t } from "elysia";
import { rm } from "node:fs/promises";
import { authGuard } from "./authGuard";
import { config } from "../config";
import { envConfig } from "../env-config";
import { STACK_NAME_RE } from "../constants/stack";
import { UPLOAD_ID_RE } from "../constants/http";
import { jobs, type JobKind, type JobSummary } from "../lib/jobs";
import {
  BACKUP_ID_RE, appFolder, backupPath, deleteBackup, getBackup, listBackups, runBackup, runImport,
  prepareUploads, runRestore, uploadPath,
} from "../lib/backups";
import { abandonUpload, checkChunkQuery, receiveChunk } from "../lib/chunked-upload";
import { restorePending } from "../lib/pending-restore";
import { service } from "../lib/providers";

/** Kinds of job that read or write the backups folder; one runs at a time. */
const BACKUP_KINDS: ReadonlySet<JobKind> = new Set(["backup", "restore", "backup-import"]);

/** The backup, restore or import job running now, if any. */
function backupJobRunning(): JobSummary | null {
  return jobs.list().find(j => j.status === "running" && BACKUP_KINDS.has(j.kind)) ?? null;
}

/** 202 with a started job; 409 with the job in the way. */
function answer(
  set: { status?: number | string },
  started: ReturnType<typeof jobs.start>,
): { job: JobSummary } | { error: string; job: JobSummary } {
  if (!started.ok) {
    set.status = 409;
    return { error: `"${started.busyWith.title}" is still running`, job: started.busyWith };
  }
  set.status = 202;
  return { job: started.job };
}

/** 409 naming the backup job already running. */
function busy(set: { status?: number | string }, running: JobSummary): { error: string; job: JobSummary } {
  set.status = 409;
  return { error: `"${running.title}" is still running: wait for it to finish`, job: running };
}

/** Names given once each, all valid stack names. Null when any is not. */
function uniqueNames(names: string[]): string[] | null {
  if (new Set(names).size !== names.length) return null;
  return names.every(n => STACK_NAME_RE.test(n)) ? names : null;
}

/**
 * Backups of the system and of apps, kept in `[backups] folder`. See src/lib/backups.ts.
 *
 * GET    /api/backups              — the backups, newest first, and where they are kept
 * GET    /api/backups/:id          — one backup's manifest
 * POST   /api/backups              — take a backup (starts a job)
 * POST   /api/backups/:id/restore  — restore apps and/or stage the system part (starts a job)
 * DELETE /api/backups/:id          — delete a backup
 * GET    /api/backups/:id/download — the backup as one tar, streamed
 * PUT    /api/backups/upload       — one chunk of an uploaded backup
 * DELETE /api/backups/upload       — abandon an upload
 * POST   /api/backups/import       — unpack a finished upload into a backup (starts a job)
 * POST   /api/backups/apply-restore — restart anpan-os so a staged system restore takes effect
 */
export function backupsPlugin(jwtSecret: string) {
  return new Elysia({ prefix: "/api/backups" })
    .use(authGuard(jwtSecret))

    .get("/", async () => ({
      folder:         config.backupsFolder,
      dataRoot:       config.appDataRoot,
      restorePending: restorePending(envConfig.RUNTIME_CONFIG_DIR),
      backups:        await listBackups(),
    }), {
      detail: { summary: "List backups, newest first" },
    })

    .post("/", async ({ body, set }) => {
      const apps = uniqueNames(body.apps);
      if (!apps) { set.status = 422; return { error: "Each app must be named once, by its stack name" }; }
      if (!body.system && apps.length === 0) { set.status = 422; return { error: "Choose the system, at least one app, or both" }; }
      const missing: string[] = [];
      for (const name of apps) if (!(await appFolder(name))) missing.push(name);
      if (missing.length > 0) { set.status = 422; return { error: `No compose file for: ${missing.join(", ")}` }; }
      const running = backupJobRunning();
      if (running) return busy(set, running);

      const what = [body.system ? "system" : null, apps.length > 0 ? `${apps.length} app${apps.length === 1 ? "" : "s"}` : null]
        .filter(Boolean).join(" and ");
      return answer(set, jobs.start(
        { kind: "backup", title: `Back up ${what}` },
        async ctx => { await runBackup(ctx, { system: body.system, apps }); },
      ));
    }, {
      body: t.Object({
        system: t.Boolean(),
        apps:   t.Array(t.String(), { maxItems: 500 }),
      }),
      detail: { summary: "Take a backup (starts a job)" },
    })

    // Registered before /:id, which would otherwise take "upload" and "import" as ids.
    .put("/upload", async ({ query, request }) => {
      const refused = checkChunkQuery(query);
      if (refused) return refused;
      const dest = uploadPath(query.id);
      return receiveChunk(dest, query, request, prepareUploads);
    }, {
      // Read the body ourselves, after the auth guard.
      parse: "none",
      query: t.Object({
        id:     t.String(),
        offset: t.Numeric({ minimum: 0 }),
        total:  t.Numeric({ minimum: 0 }),
      }),
      detail: { summary: "Upload one chunk of a backup archive" },
    })

    .delete("/upload", async ({ query, set }) => {
      if (!UPLOAD_ID_RE.test(query.id)) return Response.json({ error: "Invalid upload id" }, { status: 400 });
      const running = jobs.list().find(j => j.status === "running" && j.kind === "backup-import");
      if (running) return busy(set, running);
      // The partial file, and the finished one if the last chunk already arrived.
      await abandonUpload(uploadPath(query.id), query.id);
      await rm(uploadPath(query.id), { force: true });
      return { ok: true };
    }, {
      query: t.Object({ id: t.String() }),
      detail: { summary: "Abandon a backup upload" },
    })

    .post("/import", async ({ body, set }) => {
      if (!UPLOAD_ID_RE.test(body.upload)) { set.status = 400; return { error: "Invalid upload id" }; }
      if (!(await Bun.file(uploadPath(body.upload)).exists())) { set.status = 404; return { error: "No finished upload with that id" }; }
      const running = backupJobRunning();
      if (running) return busy(set, running);
      return answer(set, jobs.start(
        { kind: "backup-import", title: "Add an uploaded backup" },
        async ctx => { await runImport(ctx, body.upload); },
      ));
    }, {
      body: t.Object({ upload: t.String() }),
      detail: { summary: "Unpack an uploaded backup archive into the backups folder (starts a job)" },
    })

    /**
     * Restart the installed service, which applies a staged system restore as it starts.
     * Only for the installed binary: from source, the service command would restart the
     * installed copy instead of this process, so the user restarts it themselves.
     */
    .post("/apply-restore", ({ set }) => {
      if (!restorePending(envConfig.RUNTIME_CONFIG_DIR)) { set.status = 409; return { error: "No system restore is staged" }; }
      const running = backupJobRunning();
      if (running) return busy(set, running);
      const restart = envConfig.IS_BINARY_MODE ? service.restartSelfCommand() : null;
      // Fire and forget: the answer is sent before the process stops.
      if (restart) void Bun.$`${restart}`.quiet().nothrow();
      return { ok: true, restarted: restart !== null };
    }, {
      detail: { summary: "Restart anpan-os to apply a staged system restore" },
    })

    .get("/:id", async ({ params, set }) => {
      const manifest = await getBackup(params.id);
      if (!manifest) { set.status = 404; return { error: "No such backup" }; }
      return manifest;
    }, {
      detail: { summary: "One backup's manifest" },
    })

    .post("/:id/restore", async ({ params, body, set }) => {
      const manifest = await getBackup(params.id);
      if (!manifest) { set.status = 404; return { error: "No such backup" }; }
      const apps = uniqueNames(body.apps);
      if (!apps) { set.status = 422; return { error: "Each app must be named once, by its stack name" }; }
      if (!body.system && apps.length === 0) { set.status = 422; return { error: "Choose the system, at least one app, or both" }; }
      if (body.system && !manifest.system) { set.status = 422; return { error: "This backup has no system part" }; }
      const absent = apps.filter(name => !manifest.apps.some(a => a.name === name));
      if (absent.length > 0) { set.status = 422; return { error: `Not in this backup: ${absent.join(", ")}` }; }
      const running = backupJobRunning();
      if (running) return busy(set, running);

      const what = [body.system ? "system" : null, ...apps].filter(Boolean).join(", ");
      return answer(set, jobs.start(
        { kind: "restore", title: `Restore ${what} from ${params.id}` },
        ctx => runRestore(ctx, { id: params.id, system: body.system, apps }),
      ));
    }, {
      body: t.Object({
        system: t.Boolean(),
        apps:   t.Array(t.String(), { maxItems: 500 }),
      }),
      detail: { summary: "Restore apps and/or stage the system part from a backup (starts a job)" },
    })

    .delete("/:id", async ({ params, set }) => {
      if (!BACKUP_ID_RE.test(params.id)) { set.status = 404; return { error: "No such backup" }; }
      // A restore or import may be reading it.
      const running = backupJobRunning();
      if (running) return busy(set, running);
      if (!(await deleteBackup(params.id))) { set.status = 404; return { error: "No such backup" }; }
      return { ok: true };
    }, {
      detail: { summary: "Delete a backup" },
    })

    /**
     * The backup folder as one tar, made as it is sent: no copy of it is written first.
     * Upload takes the same file back.
     */
    .get("/:id/download", async ({ params, request, set }) => {
      if (!(await getBackup(params.id))) { set.status = 404; return { error: "No such backup" }; }
      const tar = Bun.which("tar");
      if (!tar) { set.status = 503; return { error: "tar is not installed on this system" }; }
      const proc = Bun.spawn([tar, "-cf", "-", "-C", config.backupsFolder, params.id], {
        cwd: backupPath(params.id), stdout: "pipe", stderr: "ignore",
      });
      // A download cancelled in the browser stops the tar.
      request.signal.addEventListener("abort", () => proc.kill(), { once: true });
      return new Response(proc.stdout, {
        headers: {
          "Content-Type":        "application/x-tar",
          "Content-Disposition": `attachment; filename="anpan-backup-${params.id}.tar"`,
        },
      });
    }, {
      detail: { summary: "Download a backup as one tar archive" },
    });
}
