import { Elysia, t } from "elysia";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { authGuard } from "./authGuard";
import { config } from "../config";
import { bins } from "../lib/commands";
import { StackStore } from "../stores/stack-store";
import { envConfig } from "../env-config";
import { STACK_TEMPLATES } from "../lib/templates";

const STACK_NAME_RE = /^[a-zA-Z0-9_-]+$/;

type LogWriter = { write(s: string): Promise<void>; flush(): Promise<void> };

async function drainStream(
  readable: ReadableStream<Uint8Array>,
  send: (data: object) => void,
  logWriter?: LogWriter,
): Promise<void> {
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
        if (line.trim()) {
          send({ log: line });
          if (logWriter) await logWriter.write(line + "\n");
        }
      }
    }
    if (buf.trim()) {
      send({ log: buf });
      if (logWriter) await logWriter.write(buf + "\n");
    }
  } finally {
    reader.releaseLock();
  }
}

function getLogPath(name: string): string {
  return join(envConfig.RUNTIME_CONFIG_DIR, "logs", `${name}.log`);
}

async function openLogWriter(name: string, label: string): Promise<LogWriter> {
  const logDir = join(envConfig.RUNTIME_CONFIG_DIR, "logs");
  mkdirSync(logDir, { recursive: true });
  const logPath = getLogPath(name);
  await appendFile(logPath, `--- ${label} ${new Date().toISOString()} ---\n`);
  return {
    write: (s: string) => appendFile(logPath, s),
    flush: async () => {},
  };
}

/**
 * Compose stack routes — all protected by auth guard.
 *
 * POST /api/compose/stacks                   — install new stack (write file + up -d)
 * PUT  /api/compose/stacks/:name/file        — update compose file + re-deploy (managed only)
 * POST /api/compose/stacks/:name/pull        — pull images + re-deploy
 * POST /api/compose/stacks/:name/down        — docker compose down
 * POST /api/compose/stacks/:name/restart     — docker compose restart
 * GET  /api/compose/stacks/:name/logs        — docker compose logs --tail=100
 * GET  /api/compose/stacks/:name/install-log — persisted install/pull log
 * GET  /api/compose/stacks/:name/file        — download compose file
 * POST /api/compose/fetch                    — proxy-fetch a remote compose URL
 * GET  /api/compose/templates                — list available stack templates
 * GET  /api/compose/templates/:id            — get template detail (includes composeYaml)
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
        const logWriter = await openLogWriter(name, "install");

        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            const send = (data: object) =>
              controller.enqueue(enc.encode(`data: ${JSON.stringify(data)}\n\n`));

            const [, , exitCode] = await Promise.all([
              drainStream(proc.stdout, send, logWriter),
              drainStream(proc.stderr, send, logWriter),
              proc.exited,
            ]);

            await logWriter.flush();

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

    .put(
      "/stacks/:name/file",
      async ({ params, body, set }) => {
        const { name } = params;
        if (!STACK_NAME_RE.test(name)) {
          set.status = 422;
          return { error: "Invalid stack name" };
        }

        const stackDir = join(config.composeFolder, name);
        if (!stackDir.startsWith(config.composeFolder)) {
          set.status = 422;
          return { error: "Invalid stack name" };
        }

        const composePath = join(stackDir, "docker-compose.yml");
        if (!(await Bun.file(composePath).exists())) {
          set.status = 404;
          return { error: "Stack not managed here" };
        }

        try {
          await Bun.write(composePath, body.content);
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

            const [, , exitCode] = await Promise.all([
              drainStream(proc.stdout, send),
              drainStream(proc.stderr, send),
              proc.exited,
            ]);

            if (exitCode === 0) {
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
        body: t.Object({ content: t.String({ minLength: 1 }) }),
      },
    )

    .post("/stacks/:name/pull", async ({ params, set }) => {
      const { name } = params;
      if (!STACK_NAME_RE.test(name)) {
        set.status = 422;
        return { error: "Invalid stack name" };
      }

      // Resolve stack directory (managed or CasaOS)
      let stackDir: string | null = null;
      const managedCompose = join(config.composeFolder, name, "docker-compose.yml");
      if (managedCompose.startsWith(config.composeFolder) && await Bun.file(managedCompose).exists()) {
        stackDir = join(config.composeFolder, name);
      } else {
        // CasaOS — requires running as root
        const casaosCompose = `/var/lib/casaos/apps/${name}/docker-compose.yml`;
        if (await Bun.file(casaosCompose).exists()) {
          stackDir = `/var/lib/casaos/apps/${name}`;
        }
      }

      if (!stackDir) {
        set.status = 404;
        return { error: "No compose file found for this stack" };
      }

      const dir = stackDir;
      const enc = new TextEncoder();
      const logWriter = await openLogWriter(name, "pull");

      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const send = (data: object) =>
            controller.enqueue(enc.encode(`data: ${JSON.stringify(data)}\n\n`));

          // Phase 1: pull images
          const pullProc = Bun.spawn(
            [bins.docker, "compose", "pull", "--progress", "plain"],
            { cwd: dir, stdout: "pipe", stderr: "pipe" },
          );
          const [, , pullExit] = await Promise.all([
            drainStream(pullProc.stdout, send, logWriter),
            drainStream(pullProc.stderr, send, logWriter),
            pullProc.exited,
          ]);

          if (pullExit !== 0) {
            await logWriter.flush();
            send({ ok: false, error: `docker compose pull failed with code ${pullExit}` });
            controller.close();
            return;
          }

          // Phase 2: re-deploy with updated images
          const upProc = Bun.spawn(
            [bins.docker, "compose", "up", "-d"],
            { cwd: dir, stdout: "pipe", stderr: "pipe" },
          );
          const [, , upExit] = await Promise.all([
            drainStream(upProc.stdout, send, logWriter),
            drainStream(upProc.stderr, send, logWriter),
            upProc.exited,
          ]);

          await logWriter.flush();

          if (upExit === 0) {
            send({ ok: true });
          } else {
            send({ ok: false, error: `docker compose up failed with code ${upExit}` });
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
    })

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

    .get("/stacks/:name/install-log", async ({ params, set }) => {
      const { name } = params;
      if (!STACK_NAME_RE.test(name)) {
        set.status = 422;
        return { error: "Invalid stack name" };
      }
      try {
        const text = await Bun.file(getLogPath(name)).text();
        return { log: text };
      } catch {
        set.status = 404;
        return { error: "No install log found for this stack" };
      }
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
    })

    .get("/templates", () =>
      STACK_TEMPLATES.map(({ id, name, icon, tagline, category, defaultPort, scheme }) => ({
        id, name, icon, tagline, category, defaultPort, scheme,
      }))
    )

    .get("/templates/:id", ({ params, set }) => {
      const tpl = STACK_TEMPLATES.find(t => t.id === params.id);
      if (!tpl) { set.status = 404; return { error: "Template not found" }; }
      return tpl;
    });
}
