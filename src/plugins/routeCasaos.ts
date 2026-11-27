import { Elysia, t } from "elysia";
import { join, resolve } from "node:path";
import { authGuard } from "./authGuard";
import { readCasaOSApps, parseCasaOSMeta, casaosStackMeta } from "../lib/casaos";
import { StackStore } from "../stores/stack-store";
import { config } from "../config";
import { bins } from "../lib/commands";
import { jobs } from "../lib/jobs";
import { checkComposeText, runMigrate } from "../lib/stack-ops";
import { CASAOS_APPS_DIR as PLATFORM_CASAOS_APPS_DIR, FEATURES } from "../lib/platform";
import { isWithinAny } from "../lib/path-guard";
import { STACK_NAME_RE } from "../constants/stack";

/**
 * CasaOS keeps its stacks here. Imported from lib/platform rather than redeclared, so the
 * path and the availability flag that gates these routes cannot drift apart.
 */
const CASAOS_APPS_DIR = PLATFORM_CASAOS_APPS_DIR;

/**
 * CasaOS compatibility routes — all protected by auth guard.
 *
 * `GET  /api/casaos/apps`           — list all local CasaOS apps parsed from compose YAMLs
 * `POST /api/casaos/import/:id`     — import x-casaos metadata into DB for a given stack
 * `POST /api/casaos/migrate/:name`  — migrate a CasaOS stack to anpan-os management (starts a job)
 *
 * The migrate endpoint:
 * 1. Requires anpan-os to run as root (rejects with an error otherwise).
 * 2. Reads the compose file from `/var/lib/casaos/apps/<name>/` (or a custom path from the body).
 * 3. Refuses if Docker runs services the file does not define (they would be removed).
 * 4. Copies it into the anpan-os managed folder, marks the stack managed with its `x-casaos`
 *    metadata, and redeploys. The same project name keeps existing volumes.
 */
export function casaosPlugin(jwtSecret: string) {
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

    /**
     * Migrate a CasaOS stack into anpan-os. Answers 202 with the job; follow it under
     * /api/jobs.
     *
     * Everything that can be checked without touching the stack is checked here, so a
     * request that cannot work gets a status. `needPath: true` on a 422 tells the dialog to
     * ask where the compose file really is.
     */
    .post(
      "/migrate/:name",
      async ({ params, body, set }) => {
        const { name } = params;

        // The name becomes anpan-os's own stack folder, join(composeFolder, name). This
        // route's own pattern once allowed dots, so ".." named the compose folder's parent.
        // The shared rule allows no dots, as Compose project names do not either.
        if (!STACK_NAME_RE.test(name)) { set.status = 422; return { error: "Invalid stack name" }; }

        // A custom path is a real feature: when CasaOS's own copy cannot be read, the dialog
        // asks for the file's actual location. But it is read as root, and taken straight
        // from the request it would bypass a narrowed files root. Hold it to the boundary the
        // file manager already enforces, plus CasaOS's app folder -- which usually lies
        // outside a root narrowed to, say, /DATA.
        const requested = body?.composePath;
        const composePath = requested
          ? resolve(requested)
          : join(CASAOS_APPS_DIR, name, "docker-compose.yml");
        // The default path is checked too: a symlink inside an app folder could otherwise
        // redirect the read anywhere, and the default should not be trusted just for being one.
        if (!isWithinAny(composePath, [CASAOS_APPS_DIR, config.filesRoot])) {
          set.status = 422;
          return { error: "That compose file is outside CasaOS's app folder and the file manager's root", needPath: true };
        }

        if (process.getuid?.() !== 0) {
          set.status = 403;
          return { error: "anpan-os must run as root to migrate CasaOS stacks" };
        }
        if (!bins.docker) { set.status = 503; return { error: "Docker is not available on this system" }; }

        let raw: string;
        try {
          raw = await Bun.file(composePath).text();
        } catch {
          set.status = 422;
          return { error: "Cannot read compose file — check the path", needPath: true };
        }
        const holder = jobs.activeFor(name);
        if (holder) { set.status = 409; return { error: `"${holder.title}" is still running for this stack`, job: holder }; }
        const bad = checkComposeText(raw, name);
        if (bad) { set.status = bad.status; return { error: bad.error }; }

        // Parse x-casaos metadata (optional — migration proceeds even without it)
        const meta = parseCasaOSMeta(raw);
        const started = jobs.start(
          { kind: "migrate", title: `Migrate ${name} from CasaOS`, stack: name },
          ctx => runMigrate(ctx, name, raw, composePath, casaosStackMeta(meta)),
        );
        if (!started.ok) {
          set.status = 409;
          return { error: `"${started.busyWith.title}" is still running for this stack`, job: started.busyWith };
        }
        set.status = 202;
        return { job: started.job };
      },
      {
        body: t.Optional(t.Object({
          composePath: t.Optional(t.String()),
        })),
        detail: { summary: "Migrate a CasaOS stack into anpan-os (starts a job)" },
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
