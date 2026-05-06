import { Elysia, t } from "elysia";
import { join } from "node:path";
import { authGuard } from "./authGuard";
import { DockerClient } from "../lib/docker";
import { StackStore } from "../stores/stack-store";
import { config } from "../config";

type ComposeOrigin = "managed" | "casaos" | null;

/** Cheaply detect where the compose file for a stack lives. */
async function detectOrigin(name: string, managed: boolean): Promise<ComposeOrigin> {
  if (managed) return "managed";
  const casaosPath = `/var/lib/casaos/apps/${name}/docker-compose.yml`;
  try {
    if (await Bun.file(casaosPath).exists()) return "casaos";
  } catch { /* directory not readable — fall through */ }
  // Fallback: try a quick sudo -n stat (handles root-owned CasaOS dirs)
  const stat = await Bun.$`sudo -n stat ${casaosPath}`.quiet().nothrow();
  if (stat.exitCode === 0) return "casaos";
  // Check managed folder as secondary (in case managed flag isn't set yet)
  const managedPath = join(config.composeFolder, name, "docker-compose.yml");
  if (managedPath.startsWith(config.composeFolder)) {
    try {
      if (await Bun.file(managedPath).exists()) return "managed";
    } catch { /* ignore */ }
  }
  return null;
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
      await Promise.all(result.data.map(s =>
        StackStore.upsert({ id: s.name, ...(s.icon ? { icon: s.icon } : {}) }),
      ));

      // Merge live Docker state with DB metadata + compose origin
      const allMeta = await StackStore.findAll();
      const metaMap = new Map(allMeta.map(m => [m.id, m]));

      return Promise.all(result.data.map(async s => {
        const meta   = metaMap.get(s.name) ?? null;
        const origin = await detectOrigin(s.name, meta?.managed ?? false);
        return { ...s, meta, origin };
      }));
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
          orderNo:     t.Optional(t.Nullable(t.Number())),
        }),
      },
    )

    // Paths that are NOT system mounts and should be surfaced to the user before deletion
    .get("/stacks/:name/binds", async ({ params, set }) => {
      const containers = await DockerClient.listProjectContainers(params.name);
      if (!containers.ok) { set.status = 502; return { error: containers.error }; }

      const SKIP = new Set(["/var/run/docker.sock", "/etc/localtime", "/etc/timezone", "/etc/hosts", "/etc/hostname"]);
      const paths = new Set<string>();

      await Promise.all(containers.data.map(async (c) => {
        const r = await DockerClient.inspectContainer(c.Id);
        if (!r.ok) return;
        for (const m of r.data.Mounts) {
          if (m.Type === "bind" && !SKIP.has(m.Source)) paths.add(m.Source);
        }
      }));

      return { paths: [...paths].sort() };
    })

    // Destroy a stack: containers → named volumes → networks → DB row.
    // Bind-mounted host paths are intentionally left untouched.
    .delete("/stacks/:name", async ({ params, set }) => {
      const containers = await DockerClient.listProjectContainers(params.name);
      if (!containers.ok) { set.status = 502; return { error: containers.error }; }

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

      return { ok: true, hostPaths: [...hostPaths].sort() };
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
    });
}
