import { Elysia, t, sse } from "elysia";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { authGuard } from "./authGuard";
import { config } from "../config";
import { bins } from "../lib/commands";
import { StackStore } from "../stores/stack-store";
import { envConfig } from "../env-config";

const STACK_NAME_RE     = /^[a-zA-Z0-9_-]+$/;
const CONTAINER_NAME_RE = /^[a-zA-Z0-9_.\-]+$/;

type LogWriter = { write(s: string): Promise<void>; flush(): Promise<void> };

interface SSEMsg { log?: string; ok?: boolean; error?: string }

const MAX_BUFFER = 256;

/** Merges parallel readable streams into a single async iterable of SSE messages. */
class StreamAggregator {
  private readonly buffer: SSEMsg[] = [];
  private consumerResolver: (() => void) | null = null;
  private readonly producerQueue: Array<() => void> = [];
  private done = false;

  async push(data: SSEMsg): Promise<void> {
    if (this.buffer.length >= MAX_BUFFER) {
      await new Promise<void>(r => { this.producerQueue.push(r); });
    }
    this.buffer.push(data);
    this.consumerResolver?.();
    this.consumerResolver = null;
  }

  end() {
    this.done = true;
    this.consumerResolver?.();
    this.consumerResolver = null;
    for (const resolve of this.producerQueue) resolve();
    this.producerQueue.length = 0;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SSEMsg> {
    while (true) {
      while (this.buffer.length > 0) {
        yield this.buffer.shift()!;
        this.producerQueue.shift()?.();
      }
      if (this.done) break;
      await new Promise<void>(r => { this.consumerResolver = r; });
    }
  }
}

async function drainStream(
  readable: ReadableStream<Uint8Array>,
  push: (data: SSEMsg) => void | Promise<void>,
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
          await push({ log: line });
          if (logWriter) await logWriter.write(line + "\n");
        }
      }
    }
    if (buf.trim()) {
      await push({ log: buf });
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
      async function*({ body }) {
        const { name, content } = body;

        if (!STACK_NAME_RE.test(name)) {
          yield sse({ data: { error: "Stack name must be alphanumeric with dashes or underscores only" } satisfies SSEMsg });
          return;
        }

        const stackDir = join(config.composeFolder, name);
        if (!stackDir.startsWith(config.composeFolder)) {
          yield sse({ data: { error: "Invalid stack name" } satisfies SSEMsg });
          return;
        }

        try {
          mkdirSync(stackDir, { recursive: true });
          await Bun.write(join(stackDir, "docker-compose.yml"), content);
        } catch (err) {
          yield sse({ data: { error: err instanceof Error ? err.message : String(err) } satisfies SSEMsg });
          return;
        }

        const proc = Bun.spawn([bins.docker, "compose", "up", "-d"], {
          cwd: stackDir,
          stdout: "pipe",
          stderr: "pipe",
        });

        const logWriter = await openLogWriter(name, "install");
        const agg = new StreamAggregator();

        void (async () => {
          try {
            const [, , exitCode] = await Promise.all([
              drainStream(proc.stdout, data => agg.push(data), logWriter),
              drainStream(proc.stderr, data => agg.push(data), logWriter),
              proc.exited,
            ]);
            if (exitCode === 0) {
              try { await StackStore.upsert({ id: name, managed: true }); } catch { /* non-critical */ }
              await agg.push({ ok: true });
            } else {
              await agg.push({ error: `docker compose exited with code ${exitCode}` });
            }
          } catch (err) {
            await agg.push({ error: err instanceof Error ? err.message : String(err) });
          } finally {
            await logWriter.flush();
            agg.end();
          }
        })();

        for await (const msg of agg) yield sse({ data: msg });
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
      async function*({ params, body }) {
        const { name } = params;
        if (!STACK_NAME_RE.test(name)) {
          yield sse({ data: { error: "Invalid stack name" } satisfies SSEMsg });
          return;
        }

        const stackDir = join(config.composeFolder, name);
        if (!stackDir.startsWith(config.composeFolder)) {
          yield sse({ data: { error: "Invalid stack name" } satisfies SSEMsg });
          return;
        }

        const composePath = join(stackDir, "docker-compose.yml");
        if (!(await Bun.file(composePath).exists())) {
          yield sse({ data: { error: "Stack not managed here" } satisfies SSEMsg });
          return;
        }

        try {
          await Bun.write(composePath, body.content);
        } catch (err) {
          yield sse({ data: { error: err instanceof Error ? err.message : String(err) } satisfies SSEMsg });
          return;
        }

        const proc = Bun.spawn([bins.docker, "compose", "up", "-d"], {
          cwd: stackDir,
          stdout: "pipe",
          stderr: "pipe",
        });

        const agg = new StreamAggregator();

        void (async () => {
          try {
            const [, , exitCode] = await Promise.all([
              drainStream(proc.stdout, data => agg.push(data)),
              drainStream(proc.stderr, data => agg.push(data)),
              proc.exited,
            ]);
            await agg.push(exitCode === 0 ? { ok: true } : { error: `docker compose exited with code ${exitCode}` });
          } catch (err) {
            await agg.push({ error: err instanceof Error ? err.message : String(err) });
          } finally {
            agg.end();
          }
        })();

        for await (const msg of agg) yield sse({ data: msg });
      },
      { body: t.Object({ content: t.String({ minLength: 1 }) }) },
    )

    .post("/stacks/:name/pull", async function*({ params }) {
      const { name } = params;
      if (!STACK_NAME_RE.test(name)) {
        yield sse({ data: { error: "Invalid stack name" } satisfies SSEMsg });
        return;
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
        yield sse({ data: { error: "No compose file found for this stack" } satisfies SSEMsg });
        return;
      }

      const dir = stackDir;
      const logWriter = await openLogWriter(name, "pull");
      const agg = new StreamAggregator();

      void (async () => {
        try {
          // Phase 1: pull images
          const pullProc = Bun.spawn(
            [bins.docker, "compose", "pull", "--progress", "plain"],
            { cwd: dir, stdout: "pipe", stderr: "pipe" },
          );
          const [, , pullExit] = await Promise.all([
            drainStream(pullProc.stdout, data => agg.push(data), logWriter),
            drainStream(pullProc.stderr, data => agg.push(data), logWriter),
            pullProc.exited,
          ]);

          if (pullExit !== 0) {
            await agg.push({ error: `docker compose pull failed with code ${pullExit}` });
            return;
          }

          // Phase 2: re-deploy with updated images
          const upProc = Bun.spawn(
            [bins.docker, "compose", "up", "-d"],
            { cwd: dir, stdout: "pipe", stderr: "pipe" },
          );
          const [, , upExit] = await Promise.all([
            drainStream(upProc.stdout, data => agg.push(data), logWriter),
            drainStream(upProc.stderr, data => agg.push(data), logWriter),
            upProc.exited,
          ]);
          await agg.push(upExit === 0 ? { ok: true } : { error: `docker compose up failed with code ${upExit}` });
        } catch (err) {
          await agg.push({ error: err instanceof Error ? err.message : String(err) });
        } finally {
          await logWriter.flush();
          agg.end();
        }
      })();

      for await (const msg of agg) yield sse({ data: msg });
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

    .get("/stacks/:name/envfile", async ({ params, set }) => {
      const { name } = params;
      if (!STACK_NAME_RE.test(name)) {
        set.status = 422;
        return { error: "Invalid stack name" };
      }
      const envPath = join(config.composeFolder, name, ".env");
      if (!envPath.startsWith(config.composeFolder)) {
        set.status = 422;
        return { error: "Invalid stack name" };
      }
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
        const envPath = join(config.composeFolder, name, ".env");
        if (!envPath.startsWith(config.composeFolder)) {
          set.status = 422;
          return { error: "Invalid stack name" };
        }
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
      const result = await Bun.$`${bins.docker} ps -a --filter ${"label=com.docker.compose.project=" + name} --format json`.nothrow();
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
        [bins.docker, "ps", "-a",
         "--filter", `label=com.docker.compose.project=${name}`,
         "--filter", `name=^/${container}$`,
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
        [bins.docker, "logs", "--tail=100", "-f", container],
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

    // ── Docker Hub tag proxy ───────────────────────────────────────────────────
    // Proxies to hub.docker.com so the browser avoids CORS and rate-limit issues.
    // image may be "nginx", "library/nginx", or "myorg/myimage".
    .get("/tags", async ({ query, set }) => {
      const image = (query as Record<string, string>).image ?? "";
      if (!image) { set.status = 422; return { error: "image query param required" }; }

      // Normalise: bare image names (e.g. "nginx") belong to "library"
      const [ns, repo] = image.includes("/") ? image.split("/", 2) : ["library", image];
      const url = `https://hub.docker.com/v2/repositories/${ns}/${repo}/tags?page_size=25&ordering=last_updated`;

      try {
        const res = await fetch(url, {
          headers: { "Accept": "application/json" },
          signal: AbortSignal.timeout(8_000),
        });
        if (!res.ok) { set.status = res.status; return { error: `Docker Hub returned ${res.status}` }; }
        const data = await res.json() as { results?: Array<{ name: string; last_updated: string }> };
        return { tags: (data.results ?? []).map(r => ({ name: r.name, updated: r.last_updated })) };
      } catch (err) {
        set.status = 502;
        return { error: err instanceof Error ? err.message : "Failed to fetch tags" };
      }
    });
}
