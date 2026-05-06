import { Elysia, t } from "elysia";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { authGuard } from "./authGuard";
import { config } from "../config";
import { bins } from "../lib/commands";
import { StackStore } from "../stores/stack-store";

const STACK_NAME_RE = /^[a-zA-Z0-9_-]+$/;

/**
 * Compose stack routes — all protected by auth guard.
 *
 * POST /api/compose/stacks                 — install new stack (write file + up -d)
 * POST /api/compose/stacks/:name/down      — docker compose down
 * POST /api/compose/stacks/:name/restart   — docker compose restart
 * GET  /api/compose/stacks/:name/logs      — docker compose logs --tail=100
 */
export function composePlugin(jwtSecret: string) {
  return new Elysia({ prefix: "/api/compose" })
    .use(authGuard(jwtSecret))

    .post(
      "/stacks",
      async ({ body, set }) => {
        const { name, content } = body;

        if (!STACK_NAME_RE.test(name)) {
          set.status = 422;
          return { error: "Stack name must be alphanumeric with dashes or underscores only" };
        }

        const stackDir = join(config.composeFolder, name);

        // Guard against path traversal
        if (!stackDir.startsWith(config.composeFolder)) {
          set.status = 422;
          return { error: "Invalid stack name" };
        }

        try {
          mkdirSync(stackDir, { recursive: true });
          await Bun.write(join(stackDir, "docker-compose.yml"), content);

          const result = await Bun.$`${bins.docker} compose up -d`.cwd(stackDir).nothrow();
          if (result.exitCode !== 0) {
            return { ok: false, error: result.stderr.toString() };
          }
          // Mark as managed so it appears in the Managed section
          await StackStore.upsert({ id: name, managed: true });
          return { ok: true };
        } catch (err) {
          set.status = 500;
          return { error: err instanceof Error ? err.message : String(err) };
        }
      },
      {
        body: t.Object({
          name:    t.String({ minLength: 1 }),
          content: t.String({ minLength: 1 }),
        }),
      },
    )

    .post("/stacks/:name/down", async ({ params, set }) => {
      const stackDir = join(config.composeFolder, params.name);
      if (!stackDir.startsWith(config.composeFolder)) {
        set.status = 422;
        return { error: "Invalid stack name" };
      }
      const result = await Bun.$`${bins.docker} compose down`.cwd(stackDir).nothrow();
      if (result.exitCode !== 0) return { ok: false, error: result.stderr.toString() };
      return { ok: true };
    })

    .post("/stacks/:name/restart", async ({ params, set }) => {
      const stackDir = join(config.composeFolder, params.name);
      if (!stackDir.startsWith(config.composeFolder)) {
        set.status = 422;
        return { error: "Invalid stack name" };
      }
      const result = await Bun.$`${bins.docker} compose restart`.cwd(stackDir).nothrow();
      if (result.exitCode !== 0) return { ok: false, error: result.stderr.toString() };
      return { ok: true };
    })

    .get("/stacks/:name/logs", async ({ params, set }) => {
      const stackDir = join(config.composeFolder, params.name);
      if (!stackDir.startsWith(config.composeFolder)) {
        set.status = 422;
        return { error: "Invalid stack name" };
      }
      const result = await Bun.$`${bins.docker} compose logs --tail=100`.cwd(stackDir).nothrow();
      return { logs: result.stdout.toString() };
    })

    .get(
      "/fetch",
      async ({ query, set }) => {
        try {
          const res = await fetch(query.url, { headers: { "Accept": "text/plain,text/yaml,*/*" } });
          if (!res.ok) {
            set.status = 502;
            return { error: `Remote returned ${res.status} ${res.statusText}` };
          }
          const text = await res.text();
          return new Response(text, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
        } catch (err) {
          set.status = 502;
          return { error: err instanceof Error ? err.message : String(err) };
        }
      },
      { query: t.Object({ url: t.String({ minLength: 1 }) }) },
    )

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
      if (managedPath.startsWith(config.composeFolder)) {
        try {
          const content = await Bun.file(managedPath).text();
          return new Response(content, { headers });
        } catch { /* fall through */ }
      }

      // 2. Try CasaOS apps directory (direct read)
      const casaosPath = `/var/lib/casaos/apps/${name}/docker-compose.yml`;
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
    });
}
