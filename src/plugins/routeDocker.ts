import { Elysia, t } from "elysia";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { authGuard } from "./authGuard";
import { DockerClient } from "../lib/docker";
import { StackStore } from "../stores/stack-store";
import { judgeStackBindPaths, judgeBindPath, otherStacksBindPaths } from "../lib/bind-paths";
import { getDiskUsage, prune, type CleanupCategory } from "../lib/docker-cleanup";
import { config } from "../config";
import { envConfig } from "../env-config";
import { CASAOS_APPS_DIR } from "../lib/platform";

type ComposeOrigin = "managed" | "casaos" | null;

/** Cache origin detection results for 5 minutes to avoid subprocess spam on every poll. */
const originCache = new Map<string, { origin: ComposeOrigin; expiresAt: number }>();
const ORIGIN_TTL  = 5 * 60 * 1000;

/** Invalidate a single stack's cached origin (call after create/delete/import). */
export function invalidateOriginCache(name: string) { originCache.delete(name); }

/** Cheaply detect where the compose file for a stack lives. Cached per-name for 5 min. */
async function detectOrigin(name: string, managed: boolean): Promise<ComposeOrigin> {
  if (managed) return "managed";

  const cached = originCache.get(name);
  if (cached && cached.expiresAt > Date.now()) return cached.origin;

  let origin: ComposeOrigin = null;

  const casaosPath = `${CASAOS_APPS_DIR}/${name}/docker-compose.yml`;
  try {
    if (await Bun.file(casaosPath).exists()) { origin = "casaos"; }
  } catch { /* directory not readable */ }

  if (!origin) {
    // Fallback: sudo -n stat handles root-owned CasaOS dirs (wrapped in try/catch in case sudo is unavailable)
    try {
      const stat = await Bun.$`sudo -n stat ${casaosPath}`.quiet().nothrow();
      if (stat.exitCode === 0) origin = "casaos";
    } catch { /* sudo not available or other spawn error */ }
  }

  if (!origin) {
    const managedPath = join(config.composeFolder, name, "docker-compose.yml");
    if (managedPath.startsWith(config.composeFolder)) {
      try {
        if (await Bun.file(managedPath).exists()) origin = "managed";
      } catch { /* ignore */ }
    }
  }

  originCache.set(name, { origin, expiresAt: Date.now() + ORIGIN_TTL });
  return origin;
}

/**
 * Docker management routes — all protected by auth guard.
 *
 * GET   /api/docker/containers
 * GET   /api/docker/containers/:id
 * POST  /api/docker/containers/:id/start
 * POST  /api/docker/containers/:id/stop
 * POST  /api/docker/containers/:id/restart
 * GET   /api/docker/containers/:id/logs
 * GET   /api/docker/info
 * GET   /api/docker/stacks          — live Docker state merged with DB metadata
 * PATCH /api/docker/stacks/:name    — update stack metadata in DB
 */
export function dockerPlugin(jwtSecret: string) {
  return new Elysia({ prefix: "/api/docker" })
    .use(authGuard(jwtSecret))

    .get("/containers", async ({ set }) => {
      const result = await DockerClient.listContainers();
      if (!result.ok) { set.status = 502; return { error: result.error }; }
      return result.data;
    })

    .get("/stacks", async ({ set }) => {
      const result = await DockerClient.listStacks();
      if (!result.ok) { set.status = 502; return { error: result.error }; }

      // Sync discovered stacks into DB (only seeds icon from Docker label; never overwrites user edits)
      // Wrapped in try/catch so a transient DB error doesn't abort the poll response.
      try {
        await Promise.all(result.data.map(s =>
          StackStore.upsert({ id: s.name, ...(s.icon ? { icon: s.icon } : {}) }),
        ));
      } catch (e) { console.error("[stacks] upsert failed:", e); }

      // Merge live Docker state with DB metadata + compose origin
      let allMeta: Awaited<ReturnType<typeof StackStore.findAll>> = [];
      try {
        allMeta = await StackStore.findAll();
      } catch (e) {
        console.error("[stacks] findAll failed:", e);
        set.status = 500;
        return { error: String(e) };
      }

      const metaMap = new Map(allMeta.map(m => [m.id, m]));

      try {
        return await Promise.all(result.data.map(async s => {
          const meta   = metaMap.get(s.name) ?? null;
          const origin = await detectOrigin(s.name, meta?.managed ?? false);
          return { ...s, meta, origin };
        }));
      } catch (e) {
        console.error("[stacks] origin detection failed:", e);
        set.status = 500;
        return { error: String(e) };
      }
    })

    .patch(
      "/stacks/:name",
      async ({ params, body, set }) => {
        const updated = await StackStore.updateMeta(params.name, body);
        if (!updated) { set.status = 404; return { error: "Stack not found in DB" }; }
        return updated;
      },
      {
        body: t.Object({
          title:       t.Optional(t.Nullable(t.String())),
          icon:        t.Optional(t.Nullable(t.String())),
          tagline:     t.Optional(t.Nullable(t.String())),
          portMap:     t.Optional(t.Nullable(t.String())),
          scheme:      t.Optional(t.Nullable(t.String())),
          indexPath:   t.Optional(t.Nullable(t.String())),
          mainService: t.Optional(t.Nullable(t.String())),
          address:     t.Optional(t.Nullable(t.String())),
          note:        t.Optional(t.Nullable(t.String())),
          openMode:    t.Optional(t.Nullable(t.String())),
          orderNo:     t.Optional(t.Nullable(t.Number())),
        }),
      },
    )

    // Paths that are NOT system mounts and should be surfaced to the user before deletion
    /**
     * Bind-mounted host paths for a stack, each with a verdict on whether it may be
     * deleted and its size on disk.
     *
     * The verdict is computed here rather than in the browser so the same rules apply to
     * the delete call, which recomputes them and does not trust what the client sends.
     */
    .get("/stacks/:name/binds", async ({ params, set }) => {
      const verdicts = await judgeStackBindPaths(params.name);
      if (verdicts.length === 0) {
        const containers = await DockerClient.listProjectContainers(params.name);
        if (!containers.ok) { set.status = 502; return { error: containers.error }; }
      }

      // du is best-effort: a size is a courtesy, and an unreadable directory should still
      // be listed rather than dropped from the dialog.
      const withSizes = await Promise.all(verdicts.map(async (v) => {
        let bytes: number | null = null;
        try {
          const out = await Bun.$`du -sb ${v.path}`.quiet().nothrow();
          if (out.exitCode === 0) {
            const parsed = Number.parseInt(out.stdout.toString().split(/\s/)[0] ?? "", 10);
            bytes = Number.isFinite(parsed) ? parsed : null;
          }
        } catch { /* leave null */ }
        return { ...v, bytes };
      }));

      return {
        paths: withSizes.map(v => v.path),          // kept for existing callers
        binds: withSizes,
      };
    })

    /** GET /api/docker/disk-usage — reclaimable space by category. Read-only. */
    .get("/disk-usage", async ({ set }) => {
      const usage = await getDiskUsage();
      if (!usage) { set.status = 502; return { error: "Could not read Docker disk usage" }; }
      return usage;
    })

    /**
     * POST /api/docker/prune — reclaim one category.
     *
     * `confirm` is required and must name the same category. Docker's prune endpoints
     * accept a bare POST and act immediately — there is no dry run, and a stray request
     * carrying a `dangling:false` filter removes every unused image on the host. Requiring
     * the category twice means a prune cannot happen by reaching the URL, only by asking
     * for that specific thing.
     */
    .post("/prune", async ({ body, set }) => {
      if (body.confirm !== body.category) {
        set.status = 422;
        return { error: "confirm must repeat the category being pruned" };
      }
      const result = await prune(body.category as CleanupCategory);
      if (result.error) { set.status = 502; return { error: result.error }; }
      return result;
    }, {
      body: t.Object({
        category: t.Union([
          t.Literal("dangling-images"), t.Literal("unused-images"), t.Literal("build-cache"),
          t.Literal("stopped-containers"), t.Literal("unused-networks"), t.Literal("unused-volumes"),
        ]),
        confirm: t.String(),
      }),
    })

    /**
     * Destroy a stack: containers, named volumes, networks, DB row, compose directory.
     *
     * Bind-mounted host paths are deleted only when explicitly named in `deletePaths`, and
     * only when they pass the checks in lib/bind-paths. Nothing is removed by default:
     * a named volume can be recreated from a compose file, while a bind directory usually
     * holds the only copy of whatever is in it.
     */
    .delete("/stacks/:name", async ({ params, body, set }) => {
      const containers = await DockerClient.listProjectContainers(params.name);
      if (!containers.ok) { set.status = 502; return { error: containers.error }; }

      // Judge the bind paths before removing containers — inspecting them afterwards is
      // impossible, and the verdicts are needed both for the response and for step 5.
      const bindVerdicts = await judgeStackBindPaths(params.name);

      // Collect bind paths before removal so we can return them
      const SKIP = new Set(["/var/run/docker.sock", "/etc/localtime", "/etc/timezone", "/etc/hosts", "/etc/hostname"]);
      const hostPaths = new Set<string>();
      const inspected = await Promise.all(containers.data.map(c => DockerClient.inspectContainer(c.Id)));
      for (const r of inspected) {
        if (!r.ok) continue;
        for (const m of r.data.Mounts) {
          if (m.Type === "bind" && !SKIP.has(m.Source)) hostPaths.add(m.Source);
        }
      }

      // 1. Remove containers (force-stops running ones, removes anonymous volumes)
      await Promise.all(containers.data.map(c => DockerClient.removeContainer(c.Id)));

      // 2. Remove named volumes
      const vols = await DockerClient.listProjectVolumes(params.name);
      if (vols.ok && vols.data.Volumes) {
        await Promise.all(vols.data.Volumes.map(v => DockerClient.removeVolume(v.Name)));
      }

      // 3. Remove networks (the default compose bridge network)
      const nets = await DockerClient.listProjectNetworks(params.name);
      if (nets.ok) {
        await Promise.all(nets.data.map(n => DockerClient.removeNetwork(n.Id)));
      }

      // 4. Remove DB metadata row
      await StackStore.delete(params.name);
      invalidateOriginCache(params.name);

      // 5. Remove bind paths the caller explicitly asked for, re-judging every one.
      //    The request names paths; it does not authorise them. The list is recomputed
      //    from Docker because the client's copy may be minutes stale, and a path that
      //    has since become shared with another stack must not be deleted on the strength
      //    of an older verdict.
      const requested = new Set(body?.deletePaths ?? []);
      const deletedPaths: string[] = [];
      const refusedPaths: Array<{ path: string; reason: string }> = [];

      if (requested.size > 0) {
        for (const verdict of bindVerdicts) {
          if (!requested.has(verdict.path)) continue;
          if (!verdict.deletable) {
            refusedPaths.push({ path: verdict.path, reason: verdict.reason });
            continue;
          }

          // Re-judge immediately before removing. The first verdict was formed before the
          // containers were removed, and another stack can start mounting a path in the
          // interval — deleting on the strength of the older answer would take data that
          // is now in use.
          const fresh = await judgeBindPath(verdict.path, await otherStacksBindPaths(params.name));
          if (!fresh.deletable) {
            refusedPaths.push({ path: verdict.path, reason: fresh.reason });
            continue;
          }

          try {
            // Delete the canonical target, not the path as written. Awaited rather than
            // synchronous: a large tree would otherwise block every other request and all
            // SSE traffic for the duration of the walk.
            await rm(fresh.canonical, { recursive: true, force: true });
            deletedPaths.push(verdict.path);
          } catch (err) {
            refusedPaths.push({
              path: verdict.path,
              reason: err instanceof Error ? err.message : String(err),
            });
          }
        }
        // A path asked for that is no longer a bind of this stack is refused by omission;
        // report it so the caller is not left believing it was removed.
        for (const p of requested) {
          if (!bindVerdicts.some(v => v.path === p)) {
            refusedPaths.push({ path: p, reason: "No longer a bind mount of this stack" });
          }
        }
      }

      // 6. Remove managed compose directory and install log (best-effort)
      const composeDir = join(config.composeFolder, params.name);
      if (composeDir.startsWith(config.composeFolder)) {
        try { await rm(composeDir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
      try { await rm(join(envConfig.RUNTIME_CONFIG_DIR, "logs", `${params.name}.log`), { force: true }); } catch { /* ignore */ }

      return { ok: true, hostPaths: [...hostPaths].sort(), deletedPaths, refusedPaths };
    }, {
      // Optional: a delete with no body removes the stack and leaves every host path,
      // which is the behaviour every existing caller expects.
      body: t.Optional(t.Object({
        deletePaths: t.Optional(t.Array(t.String())),
      })),
    })

    .get("/containers/:id", async ({ params, set }) => {
      const result = await DockerClient.inspectContainer(params.id);
      if (!result.ok) { set.status = 502; return { error: result.error }; }
      return result.data;
    })

    .post("/containers/:id/start", async ({ params, set }) => {
      const result = await DockerClient.startContainer(params.id);
      if (!result.ok) { set.status = 502; return { error: result.error }; }
      return { ok: true };
    })

    .post("/containers/:id/stop", async ({ params, set }) => {
      const result = await DockerClient.stopContainer(params.id);
      if (!result.ok) { set.status = 502; return { error: result.error }; }
      return { ok: true };
    })

    .post("/containers/:id/restart", async ({ params, set }) => {
      const result = await DockerClient.restartContainer(params.id);
      if (!result.ok) { set.status = 502; return { error: result.error }; }
      return { ok: true };
    })

    .get(
      "/containers/:id/logs",
      async ({ params, query, set }) => {
        const tail = Number(query.tail) || 100;
        const result = await DockerClient.getLogs(params.id, tail);
        if (!result.ok) { set.status = 502; return { error: result.error }; }
        return { logs: result.data };
      },
      {
        query: t.Object({ tail: t.Optional(t.String()) }),
      },
    )

    .get("/info", async ({ set }) => {
      const result = await DockerClient.getInfo();
      if (!result.ok) { set.status = 502; return { error: result.error }; }
      return result.data;
    })

    /** Host-wide totals for the dashboard summary bar. */
    .get("/summary", async ({ set }) => {
      const result = await DockerClient.getSummary();
      if (!result.ok) { set.status = 502; return { error: result.error }; }
      return result.data;
    });
}
