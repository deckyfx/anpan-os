import { Elysia } from "elysia";
import { authPlugin }   from "./plugins/routeAuth";
import { apiPlugin }    from "./plugins/routeApi";
import { dockerPlugin } from "./plugins/routeDocker";
import { composePlugin } from "./plugins/routeCompose";
import { systemPlugin } from "./plugins/routeSystem";
import { filesPlugin }  from "./plugins/routeFiles";
import { sambaPlugin }  from "./plugins/routeSamba";
import { casaosPlugin } from "./plugins/routeCasaos";

/** Core API app — no frontend routes, no listen. Used by server.ts and unit tests. */
export function createApp(jwtSecret: string) {
  return new Elysia()
    .onError(({ error, code }) => {
      if (code === "VALIDATION") {
        const first = [...error.all][0];
        return Response.json({ error: first?.message ?? error.message }, { status: 422 });
      }
    })
    .use(authPlugin(jwtSecret))
    .use(apiPlugin(jwtSecret))
    .use(dockerPlugin(jwtSecret))
    .use(composePlugin(jwtSecret))
    .use(systemPlugin(jwtSecret))
    .use(filesPlugin(jwtSecret))
    .use(sambaPlugin(jwtSecret))
    .use(casaosPlugin(jwtSecret))
    .get("/api/health", () => ({ status: "ok" }));
}

export type App = ReturnType<typeof createApp>;
