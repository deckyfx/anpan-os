import { Elysia, t, sse } from "elysia";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { authGuard } from "./authGuard";
import { readCasaOSApps, parseCasaOSMeta } from "../lib/casaos";
import { StackStore } from "../stores/stack-store";
import { config } from "../config";
import { bins } from "../lib/commands";
import { StreamAggregator, drainStream } from "../lib/sse";
import { buildComposeSourceReport, findOrphanServices } from "../lib/compose-source";
import type { SSEMsg } from "../lib/sse";
import { invalidateOriginCache } from "./routeDocker";
import { CASAOS_APPS_DIR as PLATFORM_CASAOS_APPS_DIR, FEATURES } from "../lib/platform";

/**
 * CasaOS keeps its stacks here. Imported from lib/platform rather than redeclared, so the
 * path and the availability flag that gates these routes cannot drift apart.
 */
const CASAOS_APPS_DIR = PLATFORM_CASAOS_APPS_DIR;

type MigrateMsg =
  | { step: "reading" | "writing" | "deploying" }
  | { log: string }
  | { ok: true }
  | { error: string; needPath?: true };

/**
 * CasaOS compatibility routes — all protected by auth guard.
 *
 * `GET  /api/casaos/apps`           — list all local CasaOS apps parsed from compose YAMLs
 * `POST /api/casaos/import/:id`     — import x-casaos metadata into DB for a given stack
 * `POST /api/casaos/migrate/:name`  — migrate a CasaOS stack to anpan-os management (SSE stream)
 *
 * The migrate endpoint:
 * 1. Requires anpan-os to run as root (rejects with an error otherwise).
 * 2. Reads the compose file from `/var/lib/casaos/apps/<name>/` (or a custom path from the body).
 * 3. Copies it into the anpan-os managed folder and redeploys via `docker compose up -d`.
 *    The same Docker project name ensures existing volumes are reused transparently.
 * 4. On success, marks the stack as `managed: true` and populates metadata from `x-casaos`.
 */
export function casaosPlugin(jwtSecret: string) {
  const docker = bins.docker;

  return new Elysia({ prefix: "/api/casaos" })
    .use(authGuard(jwtSecret))

    /**
     * CasaOS itself only runs on Linux, so on any other platform there is nothing to read
     * and nothing to migrate from. Refused here rather than left to fail deeper: without
     * this the routes would walk a /var/lib/casaos that cannot exist and report an empty
     * app list, which reads as "you have no CasaOS apps" instead of "this does not apply".
     *
     * The UI hides these controls entirely — see FEATURES in lib/platform — so reaching
     * this guard means a direct API call.
     */
    .onBeforeHandle(({ set }) => {
      if (!FEATURES.casaosMigration) {
        set.status = 501;
        return { error: "CasaOS migration is only available on Linux" };
      }
    })

    .get("/apps", () => readCasaOSApps())

    .post(
      "/migrate/:name",
      async function*({ params, body, request }) {
        const { name } = params;

        // Reject names containing path traversal sequences or separators.
        if (!/^[A-Za-z0-9._-]+$/.test(name)) {
          yield sse({ data: { error: "Invalid stack name" } satisfies SSEMsg });
          return;
        }

        const composePath: string = (body as { composePath?: string }).composePath
          || join(CASAOS_APPS_DIR, name, "docker-compose.yml");

        // Root check — CasaOS app dir requires root access
        if (process.getuid?.() !== 0) {
          yield sse({ data: { error: "anpan-os must run as root to migrate CasaOS stacks" } satisfies SSEMsg });
          return;
        }

        if (!docker) {
          yield sse({ data: { error: "Docker is not available on this system" } satisfies SSEMsg });
          return;
        }

        // Step 1: Read compose file
        yield sse({ data: { step: "reading" } as MigrateMsg });
        let raw: string;
        try {
          raw = await Bun.file(composePath).text();
        } catch {
          yield sse({ data: { error: "Cannot read compose file — check the path", needPath: true } as MigrateMsg });
          return;
        }

        // Parse x-casaos metadata (optional — migration proceeds even without it)
        const meta = parseCasaOSMeta(raw);

        // Step 2: Write compose file to managed folder
        yield sse({ data: { step: "writing" } as MigrateMsg });
        const stackDir = join(config.composeFolder, name);
        try {
          mkdirSync(stackDir, { recursive: true });
          await Bun.write(join(stackDir, "docker-compose.yml"), raw);
        } catch (err) {
          yield sse({ data: { error: err instanceof Error ? err.message : String(err) } satisfies SSEMsg });
          return;
        }

        // Guard: --remove-orphans deletes any container in the project that this compose
        // file does not define. A CasaOS project can have picked up services from another
        // compose file over its life, and those are exactly the containers the CasaOS file
        // omits — migrating would destroy them silently. Refuse and name them instead.
        const orphanCheck = await findOrphanServices(await buildComposeSourceReport(name));
        if (!orphanCheck.ok) {
          yield sse({ data: { error: orphanCheck.error } satisfies SSEMsg });
          return;
        }
        if (orphanCheck.orphans.length > 0) {
          yield sse({ data: { error:
            `Migration would delete these running services, which ${composePath} does not define: `
            + `${orphanCheck.orphans.join(", ")}. Merge them into the compose file first.`
          } satisfies SSEMsg });
          return;
        }

        // Step 3: Deploy via docker compose up -d
        //
        // --force-recreate is required, not optional. Plain `up -d` only recreates
        // containers whose service definition changed; identical ones keep running with
        // the labels of the compose file that created them — i.e. still pointing at the
        // CasaOS path we are migrating away from. That leaves the project split across
        // two compose files (visible in `docker compose ls`), and once the CasaOS file is
        // removed those containers reference a file that no longer exists.
        yield sse({ data: { step: "deploying" } as MigrateMsg });

        const agg = new StreamAggregator();

        const proc = Bun.spawn([docker, "compose", "up", "-d", "--remove-orphans", "--force-recreate"], {
          cwd: stackDir,
          stdout: "pipe",
          stderr: "pipe",
        });

        // Without this, a client that disconnects mid-migration leaves the producers
        // suspended in agg.push once the buffer fills, leaking the subprocess and its pipes.
        request.signal.addEventListener("abort", () => { proc.kill(); agg.end(); }, { once: true });

        void (async () => {
          try {
            const [, , exitCode] = await Promise.all([
              drainStream(proc.stdout, data => agg.push(data)),
              drainStream(proc.stderr, data => agg.push(data)),
              proc.exited,
            ]);

            if (exitCode === 0) {
              // Ensure row exists, then explicitly set managed + x-casaos metadata.
              // updateMeta is used because StackStore.upsert's ON CONFLICT SET clause
              // does not include `managed`, so upsert alone would not persist managed=true.
              await StackStore.upsert({ id: name });
              await StackStore.updateMeta(name, {
                managed:     true,
                title:       meta?.title       || undefined,
                icon:        meta?.icon        || undefined,
                tagline:     meta?.tagline     || undefined,
                note:        meta?.tips        || undefined,
                portMap:     meta?.portMap     || undefined,
                scheme:      meta?.scheme      || undefined,
                indexPath:   meta?.index       || undefined,
                mainService: meta?.mainService || undefined,
              });
              invalidateOriginCache(name);
              await agg.push({ ok: true });
            } else {
              await agg.push({ error: `docker compose exited with code ${exitCode}` });
            }
          } catch (err) {
            await agg.push({ error: err instanceof Error ? err.message : String(err) });
          } finally {
            agg.end();
          }
        })();

        for await (const msg of agg) yield sse({ data: msg });
      },
      {
        body: t.Optional(t.Object({
          composePath: t.Optional(t.String()),
        })),
      },
    )

    .post("/import/:id", async ({ params, set }) => {
      const apps = await readCasaOSApps();
      const app  = apps.find(a => a.id === params.id);
      if (!app) { set.status = 404; return { error: "CasaOS app not found" }; }

      const patch = {
        title:       app.title       || undefined,
        icon:        app.icon        || undefined,
        tagline:     app.tagline     || undefined,
        note:        app.tips        || undefined,
        portMap:     app.portMap     || undefined,
        scheme:      app.scheme      || undefined,
        indexPath:   app.index       || undefined,
        mainService: app.mainService || undefined,
        managed:     true,
      };

      const existing = await StackStore.findById(params.id);
      if (existing) {
        return StackStore.updateMeta(params.id, patch);
      }
      // Stack row may not exist yet if Docker hasn't been synced — upsert it
      return StackStore.upsert({ id: params.id, ...patch });
    });
}
