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

        if (!stackDir.startsWith(config.composeFolder)) {
          set.status = 422;
          return { error: "Invalid stack name" };
        }

        try {
          mkdirSync(stackDir, { recursive: true });
          await Bun.write(join(stackDir, "docker-compose.yml"), content);
        } catch (err) {
          set.status = 500;
          return { error: err instanceof Error ? err.message : String(err) };
        }

        const proc = Bun.spawn([bins.docker, "compose", "up", "-d"], {
          cwd: stackDir,
          stdout: "pipe",
          stderr: "pipe",
        });

        const enc = new TextEncoder();

        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            const send = (data: object) =>
              controller.enqueue(enc.encode(`data: ${JSON.stringify(data)}\n\n`));

            async function drain(readable: ReadableStream<Uint8Array>) {
              const reader = readable.getReader();
              const dec = new TextDecoder();
              let buf = "";
              try {
                while (true) {
                  const { done, value } = await reader.read();
                  if (done) break;
                  buf += dec.decode(value, { stream: true });
                  const lines = buf.split("\n");
                  buf = lines.pop() ?? "";
                  for (const line of lines) {
                    if (line.trim()) send({ log: line });
                  }
                }
                if (buf.trim()) send({ log: buf });
              } finally {
                reader.releaseLock();
              }
            }

            const [, , exitCode] = await Promise.all([
              drain(proc.stdout),
              drain(proc.stderr),
              proc.exited,
            ]);

            if (exitCode === 0) {
              try { await StackStore.upsert({ id: name, managed: true }); } catch { /* non-critical */ }
              send({ ok: true });
            } else {
              send({ ok: false, error: `docker compose exited with code ${exitCode}` });
            }

            controller.close();
          },
        });

        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
          },
        });
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

    .post(
      "/fetch",
      async ({ body, set }) => {
        try {
          const res = await fetch(body.url, { headers: { "Accept": "text/plain,text/yaml,*/*" } });
          if (!res.ok) {
            set.status = 502;
            return { error: `Remote returned ${res.status} ${res.statusText}` };
          }
          const content = await res.text();
          return { content };
        } catch (err) {
          set.status = 502;
          return { error: err instanceof Error ? err.message : String(err) };
        }
      },
      { body: t.Object({ url: t.String({ minLength: 1 }) }) },
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
