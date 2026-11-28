import { Elysia, t, sse } from "elysia";
import { join } from "node:path";
import { authGuard } from "./authGuard";
import { config } from "../config";
import { bins, commands } from "../lib/commands";
import { StackStore } from "../stores/stack-store";
import { StreamAggregator, drainStream } from "../lib/sse";
import type { SSEMsg } from "../lib/sse";
import { jobs, stackLogPath, type JobSummary } from "../lib/jobs";
import {
  checkInstall, checkRedeploy, runDeploy, runRepair, runUpdate, runUpdateAll, updatableDir,
  type DeployRequest,
} from "../lib/stack-ops";
import { DockerClient } from "../lib/docker";
import { buildComposeSourceReport, scanComposeSources } from "../lib/compose-source";
import type { ComposeSourceReport } from "../lib/compose-source";
import { CASAOS_APPS_DIR } from "../lib/platform";
import { STACK_NAME_RE } from "../constants/stack";
import { COMPOSE_FILE, composeCommand } from "../lib/compose-cmd";
import { listTags } from "../lib/registry";
import { loadDockerCredentials } from "../lib/docker-credentials";

const CONTAINER_NAME_RE = /^[a-zA-Z0-9_.\-]+$/;

/** The tile metadata an install or redeploy may set, as the stack PATCH accepts it. */
const META_SCHEMA = t.Object({
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
});

/**
 * The answer to a request that starts a job: 202 with the job, or 409 with the job already
 * working on the stack, so the client can show that one instead.
 */
/**
 * 409 with the job holding `stack`, if one is. Checked before a route's own refusals, so a
 * second install of a name that a running install has just written gets that job to follow
 * rather than a bare "already exists".
 */
function busy(set: { status?: number | string }, stack: string): { error: string; job: JobSummary } | null {
  const holder = jobs.activeFor(stack);
  if (!holder) return null;
  set.status = 409;
  return { error: `"${holder.title}" is still running for this stack`, job: holder };
}

function answer(
  set: { status?: number | string },
  started: ReturnType<typeof jobs.start>,
): { job: JobSummary } | { error: string; job: JobSummary } {
  if (!started.ok) {
    set.status = 409;
    return { error: `"${started.busyWith.title}" is still running for this stack`, job: started.busyWith };
  }
  set.status = 202;
  return { job: started.job };
}

/**
 * Compose stack routes — all protected by auth guard.
 *
 * Starting a job (202 with the job; follow it under /api/jobs):
 * POST /api/compose/stacks                   — install a new stack
 * PUT  /api/compose/stacks/:name/file        — replace a managed stack's files and redeploy
 * POST /api/compose/stacks/:name/pull        — pull images and redeploy
 * POST /api/compose/stacks/:name/repair      — re-anchor a stack on its managed file
 * POST /api/compose/update-all               — update several stacks in sequence
 *
 * Immediate:
 * POST /api/compose/stacks/:name/down        — docker compose down
 * POST /api/compose/stacks/:name/restart     — docker compose restart
 * GET  /api/compose/stacks/:name/logs        — docker compose logs --tail=100
 * GET  /api/compose/stacks/:name/install-log — the stack's persisted operation log
 * GET  /api/compose/stacks/:name/file        — download the compose file
 * GET/PUT /api/compose/stacks/:name/envfile  — read or write the stack's .env
 */
/**
 * Compose endpoints that never invoke Docker, by method and path.
 *
 * `/tags` queries Docker Hub over HTTPS, and the rest read or write files under the compose
 * folder. Blocking them when the daemon is absent means a machine with no Docker installed
 * cannot view its own compose file, read an install log, or edit an env file — none of
 * which the daemon has any part in.
 *
 * The method matters as much as the path, and the two `/file` routes are why: GET returns
 * the compose file, while PUT rewrites it and then runs `docker compose up`. Exempting the
 * path alone let that PUT past the guard, so on a host without Docker it would persist the
 * user's edit and only then fail on the deploy — leaving the stack's file changed and its
 * containers untouched, which is worse than refusing the request outright.
 *
 * Matched as whole paths rather than by suffix, too: a stack legitimately named "file"
 * would make `/api/compose/stacks/file` end in "/file" and slip past.
 *
 * Anything not listed here requires Docker. New routes are therefore guarded by default.
 */
const DOCKER_FREE_ROUTES: { method: string; pattern: RegExp }[] = [
  { method: "GET", pattern: /^\/api\/compose\/tags$/ },
  { method: "GET", pattern: /^\/api\/compose\/compose-sources$/ },
  { method: "GET", pattern: /^\/api\/compose\/stacks\/[^/]+\/(install-log|file|compose-source|envfile)$/ },
  // Writing an env file touches no container; the compose file's PUT does, so it is absent.
  { method: "PUT", pattern: /^\/api\/compose\/stacks\/[^/]+\/envfile$/ },
];

/** True when the request needs a reachable Docker daemon. Exported for tests. */
export function needsDocker(method: string, path: string): boolean {
  const verb = method.toUpperCase();
  return !DOCKER_FREE_ROUTES.some((r) => r.method === verb && r.pattern.test(path));
}

export function composePlugin(jwtSecret: string) {
  const docker = bins.docker; // the name to invoke; presence is checked per request below

  return new Elysia({ prefix: "/api/compose" })
    .use(authGuard(jwtSecret))
    /**
     * Rejects a bad stack name with a real status before the stream opens.
     *
     * Validating inside the generator meant the response was 200 with an error event in
     * the body: the UI coped because it reads the stream, but any other client — or a
     * script — saw a rejected request as success. Headers are not sent until the first
     * yield, so a guard here can still set a status.
     */
    .onBeforeHandle(({ path, body, set }) => {
      if (path !== "/api/compose/stacks") return;
      const name = (body as { name?: unknown } | null)?.name;
      if (typeof name !== "string" || !STACK_NAME_RE.test(name)) {
        set.status = 422;
        return { error: "Stack name must be alphanumeric with dashes or underscores only" };
      }
    })

    /**
     * The same rule for every `/stacks/:name/...` route, where the name arrives in the path.
     *
     * Each route used to guard its directory with `stackDir.startsWith(composeFolder)`. With
     * no separator in the comparison, `..%2Fcomposes-x` resolves to the sibling folder
     * `composes-x` and passes — and down, restart and logs had no other check, so they would
     * run `docker compose` in it. A name that matches STACK_NAME_RE cannot leave the folder
     * at all, so the prefix checks are gone and this is the one place that decides.
     */
    .onBeforeHandle(({ params, set }) => {
      const name = (params as { name?: string } | undefined)?.name;
      if (name !== undefined && !STACK_NAME_RE.test(name)) {
        set.status = 422;
        return { error: "Invalid stack name" };
      }
    })

    /**
     * Refuse Docker-backed routes when Docker cannot be reached.
     *
     * `bins.docker` being set means only that Docker is possible on this OS; whether it is
     * installed is a separate question, and on macOS the common case is that it is not —
     * Docker Desktop, OrbStack and Colima are all third-party. Cached in the registry, so
     * this is a map lookup after the first request rather than a `which` per call.
     *
     * Registered after the name check on purpose. A malformed stack name is wrong whatever
     * state the daemon is in, and 422 tells the caller something they can act on, where a
     * 503 would send them to look at Docker over a typo.
     *
     * Scoped, too: several endpoints here only read or write files, and refusing those
     * would mean a host without Docker could not so much as view its own compose file.
     */
    .onBeforeHandle(async ({ set, path, request }) => {
      if (!needsDocker(request.method, path)) return;
      if (!docker || !(await commands.isAvailable("docker"))) {
        set.status = 503;
        return { error: "Docker is not installed or not running — see System Doctor" };
      }
    })

    /**
     * Install a new stack. Answers 202 with the job; follow it under /api/jobs.
     *
     * The compose file, `.env` and the tile's metadata come in this one request and are all
     * written before the first `docker compose up`. A name already in use is refused with
     * 409 rather than overwritten.
     */
    .post(
      "/stacks",
      async ({ body, set }) => {
        const req: DeployRequest = { name: body.name, compose: body.content, env: body.env, meta: body.meta };
        const holder = busy(set, req.name);
        if (holder) return holder;
        const refused = await checkInstall(req);
        if (refused) { set.status = refused.status; return { error: refused.error }; }
        return answer(set, jobs.start(
          { kind: "install", title: `Install ${req.name}`, stack: req.name },
          ctx => runDeploy(ctx, "install", req),
        ));
      },
      {
        body: t.Object({
          name:    t.String({ minLength: 1 }),
          content: t.String({ minLength: 1, description: "The compose file" }),
          env:     t.Optional(t.String({ description: "The stack's .env file" })),
          meta:    t.Optional(META_SCHEMA),
        }),
        detail: { summary: "Install a new stack (starts a job)" },
      },
    )

    /** Replace a managed stack's compose file (and optionally .env and metadata), then redeploy. */
    .put(
      "/stacks/:name/file",
      async ({ params, body, set }) => {
        const req: DeployRequest = { name: params.name, compose: body.content, env: body.env, meta: body.meta };
        const holder = busy(set, req.name);
        if (holder) return holder;
        const refused = await checkRedeploy(req);
        if (refused) { set.status = refused.status; return { error: refused.error }; }
        return answer(set, jobs.start(
          { kind: "redeploy", title: `Redeploy ${req.name}`, stack: req.name },
          ctx => runDeploy(ctx, "redeploy", req),
        ));
      },
      {
        body: t.Object({
          content: t.String({ minLength: 1, description: "The compose file" }),
          env:     t.Optional(t.String({ description: "The stack's .env file; omitted keeps the current one" })),
          meta:    t.Optional(META_SCHEMA),
        }),
        detail: { summary: "Replace a stack's compose file and redeploy (starts a job)" },
      },
    )

    /** Pull a stack's images and recreate what changed. Works on CasaOS stacks too. */
    .post("/stacks/:name/pull", async ({ params, set }) => {
      const holder = busy(set, params.name);
      if (holder) return holder;
      const dir = await updatableDir(params.name);
      if (!dir) { set.status = 404; return { error: "No compose file found for this stack" }; }
      return answer(set, jobs.start(
        { kind: "update", title: `Update ${params.name}`, stack: params.name },
        ctx => runUpdate(ctx, params.name, dir),
      ));
    }, {
      detail: { summary: "Pull a stack's images and redeploy (starts a job)" },
    })

    /**
     * Update several stacks, one after another, in one job.
     *
     * Runs in the server, so it carries on with the tab closed. It used to be a queue in the
     * browser that also gave up on any stack after five minutes.
     */
    .post("/update-all", ({ body, set }) => {
      const stacks = [...new Set(body.stacks)];
      const bad = stacks.find(name => !STACK_NAME_RE.test(name));
      if (bad !== undefined) { set.status = 422; return { error: `Invalid stack name: ${bad}` }; }
      return answer(set, jobs.start(
        { kind: "update-all", title: `Update ${stacks.length} stack${stacks.length === 1 ? "" : "s"}` },
        ctx => runUpdateAll(ctx, stacks),
      ));
    }, {
      body: t.Object({ stacks: t.Array(t.String(), { minItems: 1, maxItems: 500 }) }),
      detail: { summary: "Update several stacks in sequence (starts a job)" },
    })

    // These three run Compose the way the jobs do (composeCommand: `-p <stack>` and the
    // stack's own file), so `down` stops the project an install started, whatever the
    // stack's .env says COMPOSE_PROJECT_NAME is. Stopping or restarting a stack a job is
    // working on is refused with that job, as every other stack-changing route is.
    .post("/stacks/:name/down", async ({ params, set }) => {
      if (!STACK_NAME_RE.test(params.name)) { set.status = 422; return { ok: false, error: "Invalid stack name" }; }
      const stackDir = join(config.composeFolder, params.name);
      if (!(await Bun.file(join(stackDir, COMPOSE_FILE)).exists())) { set.status = 404; return { ok: false, error: `Stack "${params.name}" is not managed by anpan-os` }; }
      // Checked after the await above, with none between it and the command: a job that
      // took the stack while the file was being checked is seen here.
      const held = busy(set, params.name);
      if (held) return { ok: false, ...held };
      const result = await Bun.$`${composeCommand(docker!, params.name, stackDir)} down`.cwd(stackDir).nothrow().quiet();
      if (result.exitCode !== 0) return { ok: false, error: result.stderr.toString() };
      return { ok: true };
    })

    .post("/stacks/:name/restart", async ({ params, set }) => {
      if (!STACK_NAME_RE.test(params.name)) { set.status = 422; return { ok: false, error: "Invalid stack name" }; }
      const stackDir = join(config.composeFolder, params.name);
      if (!(await Bun.file(join(stackDir, COMPOSE_FILE)).exists())) { set.status = 404; return { ok: false, error: `Stack "${params.name}" is not managed by anpan-os` }; }
      // Checked after the await above, with none between it and the command: a job that
      // took the stack while the file was being checked is seen here.
      const held = busy(set, params.name);
      if (held) return { ok: false, ...held };
      const result = await Bun.$`${composeCommand(docker!, params.name, stackDir)} restart`.cwd(stackDir).nothrow().quiet();
      if (result.exitCode !== 0) return { ok: false, error: result.stderr.toString() };
      return { ok: true };
    })

    .get("/stacks/:name/logs", async ({ params, set }) => {
      if (!STACK_NAME_RE.test(params.name)) { set.status = 422; return { error: "Invalid stack name" }; }
      const stackDir = join(config.composeFolder, params.name);
      if (!(await Bun.file(join(stackDir, COMPOSE_FILE)).exists())) { set.status = 404; return { ok: false, error: `Stack "${params.name}" is not managed by anpan-os` }; }
      const result = await Bun.$`${composeCommand(docker!, params.name, stackDir)} logs --tail=100`.cwd(stackDir).nothrow().quiet();
      return { logs: result.stdout.toString() };
    })

    .get("/stacks/:name/install-log", async ({ params, set }) => {
      const { name } = params;
      if (!STACK_NAME_RE.test(name)) {
        set.status = 422;
        return { error: "Invalid stack name" };
      }
      try {
        const text = await Bun.file(stackLogPath(name)).text();
        return { log: text };
      } catch {
        set.status = 404;
        return { error: "No install log found for this stack" };
      }
    })

    .get("/stacks/:name/file", async ({ params, set }) => {
      const { name } = params;
      if (!STACK_NAME_RE.test(name)) {
        set.status = 422;
        return { error: "Invalid stack name" };
      }

      const headers = {
        "Content-Type": "text/yaml; charset=utf-8",
        "Content-Disposition": `attachment; filename="${name}-docker-compose.yml"`,
      };

      // 1. Try managed compose folder
      const managedPath = join(config.composeFolder, name, "docker-compose.yml");
      try {
        const content = await Bun.file(managedPath).text();
        return new Response(content, { headers });
      } catch { /* fall through */ }

      // 2. Try CasaOS apps directory (direct read)
      const casaosPath = `${CASAOS_APPS_DIR}/${name}/docker-compose.yml`;
      try {
        const content = await Bun.file(casaosPath).text();
        return new Response(content, { headers });
      } catch { /* fall through */ }

      // 3. Fallback: sudo -n for root-owned CasaOS files
      const result = await Bun.$`sudo -n cat ${casaosPath}`.quiet().nothrow();
      if (result.exitCode === 0) {
        return new Response(result.stdout.toString(), { headers });
      }

      set.status = 404;
      return { error: "Compose file not found for this stack" };
    })

    /**
     * Report which compose file each container of this stack was created from, and
     * whether they all agree with the managed path.
     */
    .get("/stacks/:name/compose-source", async ({ params, set }) => {
      const { name } = params;
      if (!STACK_NAME_RE.test(name)) {
        set.status = 422;
        return { error: "Invalid stack name" };
      }
      return buildComposeSourceReport(name);
    })

    /** Scan every compose project on the host and return those needing repair. */
    .get("/compose-sources", async ({ query }) => {
      const reports: ComposeSourceReport[] = await scanComposeSources();
      // ?all=1 returns every stack including healthy ones; default is the actionable set.
      return { stacks: query.all === "1" ? reports : reports.filter(r => r.needsRepair) };
    })

    /**
     * Re-anchor a stack onto the managed compose file.
     *
     * Adopts the stack's existing compose file into the managed folder when one is not
     * there yet, then redeploys with --force-recreate so every container is rebuilt and
     * relabelled against the managed path. The project name is unchanged, so named
     * volumes and networks are reused — but containers ARE recreated, which means a brief
     * restart and the loss of anything written to a container's writable layer.
     *
     * Only stacks that actually need repair are accepted. An `external` stack — one wholly
     * owned by another tool — is a valid state, not a fault, and repairing it would copy its
     * compose file into our folder and restart every container. That takes `?adopt=1`, an
     * explicit statement of intent, rather than being reachable by stack name alone.
     */
    .post("/stacks/:name/repair", async ({ params, query, set }) => {
      const { name } = params;
      const holder = busy(set, name);
      if (holder) return holder;
      const report = await buildComposeSourceReport(name);

      // Deliberately narrower than "reject whenever needsRepair is false": adopting an
      // external stack on purpose is a real workflow, so it stays available behind ?adopt=1
      // instead of being refused outright. `ok` and `unknown` have nothing to repair.
      const mayAdoptExternal = report.status === "external" && query.adopt === "1";
      if (!report.needsRepair && !mayAdoptExternal) {
        set.status = 409;
        return { error: report.status === "external"
          ? `Stack "${name}" is managed outside anpan-os (${report.foreignPaths.join(", ")}). `
            + `Repairing would take it over and restart every container — resend with ?adopt=1 to confirm.`
          : `Stack "${name}" reports status "${report.status}" and does not need repair.` };
      }
      return answer(set, jobs.start(
        { kind: "repair", title: `Repair ${name}`, stack: name },
        ctx => runRepair(ctx, name, mayAdoptExternal),
      ));
    }, {
      detail: { summary: "Re-anchor a stack on its managed compose file (starts a job)" },
    })

    .get("/stacks/:name/envfile", async ({ params, set }) => {
      const { name } = params;
      if (!STACK_NAME_RE.test(name)) {
        set.status = 422;
        return { error: "Invalid stack name" };
      }
      const envPath = join(config.composeFolder, name, ".env");
      try {
        const content = await Bun.file(envPath).text();
        return { content };
      } catch {
        set.status = 404;
        return { error: "not found" };
      }
    })

    .put(
      "/stacks/:name/envfile",
      async ({ params, body, set }) => {
        const { name } = params;
        if (!STACK_NAME_RE.test(name)) {
          set.status = 422;
          return { error: "Invalid stack name" };
        }
        // A job holding the stack may have checked the current .env (ports, values) and be
        // about to start it; a write now would change what Compose reads after the check.
        const holder = busy(set, name);
        if (holder) return holder;
        const envPath = join(config.composeFolder, name, ".env");
        try {
          await Bun.write(envPath, body.content);
          return { ok: true };
        } catch (err) {
          set.status = 500;
          return { error: err instanceof Error ? err.message : String(err) };
        }
      },
      { body: t.Object({ content: t.String() }) },
    )

    // ── Per-container live logs ────────────────────────────────────────────────

    /** List containers in a compose project (includes stopped). */
    .get("/stacks/:name/containers", async ({ params, set }) => {
      const { name } = params;
      if (!STACK_NAME_RE.test(name)) {
        set.status = 422;
        return { error: "Invalid stack name" };
      }
      // Use docker ps with project label filter — works regardless of compose file location
      const result = await Bun.$`${docker!} ps -a --filter ${"label=com.docker.compose.project=" + name} --format json`.nothrow();
      if (result.exitCode !== 0) {
        set.status = 502;
        return { error: result.stderr.toString() || "docker ps failed" };
      }
      const containers = result.stdout.toString().trim().split("\n").filter(Boolean).flatMap(line => {
        try {
          const obj = JSON.parse(line) as Record<string, string>;
          const labels: Record<string, string> = {};
          for (const kv of (obj.Labels ?? "").split(",")) {
            const eq = kv.indexOf("=");
            if (eq > 0) labels[kv.slice(0, eq)] = kv.slice(eq + 1);
          }
          return [{
            name:    (obj.Names ?? "").replace(/^\//, ""),
            service: labels["com.docker.compose.service"] ?? "",
            state:   obj.State ?? "",
            status:  obj.Status ?? "",
          }];
        } catch { return []; }
      });
      return containers;
    })

    /** Stream live logs for a specific container via SSE (docker logs --tail=100 -f). */
    .get("/stacks/:name/containers/:container/logs", async function*({ params, request }) {
      const { name, container } = params;
      if (!STACK_NAME_RE.test(name) || !CONTAINER_NAME_RE.test(container)) {
        yield sse({ data: { error: "Invalid name" } satisfies SSEMsg });
        return;
      }

      // Verify the container actually belongs to this compose project before streaming.
      const checkProc = Bun.spawn(
        [docker!, "ps", "-a",
         "--filter", `label=com.docker.compose.project=${name}`,
         "--filter", `name=^${container}$`,
         "--format", "{{.Names}}"],
        { stdout: "pipe", stderr: "pipe" },
      );
      await checkProc.exited;
      const matched = (await new Response(checkProc.stdout).text()).trim();
      if (!matched) {
        yield sse({ data: { error: "Container not found in this stack" } satisfies SSEMsg });
        return;
      }

      const proc = Bun.spawn(
        [docker!, "logs", "--tail=100", "-f", container],
        { stdout: "pipe", stderr: "pipe" },
      );

      // Kill the subprocess when the HTTP connection closes
      request.signal.addEventListener("abort", () => { proc.kill(); }, { once: true });

      const agg = new StreamAggregator();

      void (async () => {
        try {
          await Promise.all([
            drainStream(proc.stdout, data => agg.push(data)),
            drainStream(proc.stderr, data => agg.push(data)),
            proc.exited,
          ]);
        } catch {
          // Expected when process is killed on disconnect
        } finally {
          agg.end();
        }
      })();

      for await (const msg of agg) yield sse({ data: msg });
    })

    // ── Image tag lookup ──────────────────────────────────────────────────────
    // Done server-side so the browser avoids CORS, and so registry logins stay on the host.
    // `image` is a name without a tag: "nginx", "jellyfin/jellyfin", "ghcr.io/owner/app".
    .get("/tags", async ({ query, set }) => {
      const image = query.image.trim();
      if (!image) { set.status = 422; return { error: "image query param required" }; }

      const result = await listTags(image, { credentials: await loadDockerCredentials() });
      if (result.ok) return { tags: result.tags };

      // Never 401: the client reads that as its own session having expired.
      set.status = { invalid: 422, "not-found": 404, "rate-limited": 429, failed: 502 }[result.reason];
      return { error: result.error };
    }, {
      query: t.Object({
        image: t.String({ description: "Image name without a tag, e.g. `nginx`, `jellyfin/jellyfin`, `ghcr.io/owner/app`" }),
      }),
      detail: { summary: "List the tags of an image from its own registry" },
    });
}
