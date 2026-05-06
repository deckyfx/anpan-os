import { Elysia, t } from "elysia";
import { authGuard } from "./authGuard";
import { DockerClient } from "../lib/docker";
import { StackStore } from "../stores/stack-store";

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

      // Merge live Docker state with DB metadata
      const allMeta = await StackStore.findAll();
      const metaMap = new Map(allMeta.map(m => [m.id, m]));

      return result.data.map(s => ({
        ...s,
        meta: metaMap.get(s.name) ?? null,
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
          title:       t.Optional(t.String()),
          icon:        t.Optional(t.String()),
          tagline:     t.Optional(t.String()),
          portMap:     t.Optional(t.String()),
          scheme:      t.Optional(t.String()),
          indexPath:   t.Optional(t.String()),
          mainService: t.Optional(t.String()),
          note:        t.Optional(t.Nullable(t.String())),
          orderNo:     t.Optional(t.Nullable(t.Number())),
        }),
      },
    )

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
