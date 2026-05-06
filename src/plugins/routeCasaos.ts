import { Elysia } from "elysia";
import { authGuard } from "./authGuard";
import { readCasaOSApps } from "../lib/casaos";
import { StackStore } from "../stores/stack-store";

/**
 * CasaOS compatibility routes — all protected by auth guard.
 *
 * GET  /api/casaos/apps          — list all CasaOS apps parsed from compose YAMLs
 * POST /api/casaos/import/:id    — import x-casaos metadata into DB for a given stack
 */
export function casaosPlugin(jwtSecret: string) {
  return new Elysia({ prefix: "/api/casaos" })
    .use(authGuard(jwtSecret))

    .get("/apps", () => readCasaOSApps())

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
