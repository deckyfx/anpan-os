import { Elysia } from "elysia";
import { authPlugin } from "./plugins/routeAuth";
import { passkeyPlugin } from "./plugins/routePasskey";
import { apiPlugin } from "./plugins/routeApi";
import { dockerPlugin } from "./plugins/routeDocker";
import { composePlugin } from "./plugins/routeCompose";
import { systemPlugin } from "./plugins/routeSystem";
import { filesPlugin } from "./plugins/routeFiles";
import { sambaPlugin } from "./plugins/routeSamba";
import { casaosPlugin } from "./plugins/routeCasaos";
import { portsPlugin }      from "./plugins/routePorts";
import { bookmarksPlugin }  from "./plugins/routeBookmarks";
import { appStorePlugin }   from "./plugins/routeAppStore";

function errorPage(title: string, detail: string, stack?: string): Response {
  const rows = stack
    ? stack.split("\n").map(l => `<tr><td>${l.replace(/</g, "&lt;")}</td></tr>`).join("")
    : "";
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>500 – ${title.replace(/</g, "&lt;")}</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{background:#0a0a0f;color:#e5e7eb;font-family:ui-monospace,monospace;padding:2rem}
    h1{color:#f87171;font-size:1.25rem;margin-bottom:.5rem}
    p{color:#9ca3af;font-size:.85rem;margin-bottom:1.5rem}
    details{border:1px solid #374151;border-radius:.5rem;overflow:hidden}
    summary{background:#111827;padding:.75rem 1rem;cursor:pointer;font-size:.8rem;color:#6b7280}
    summary:hover{color:#d1d5db}
    table{width:100%;border-collapse:collapse}
    td{padding:.25rem 1rem;font-size:.75rem;color:#d1fae5;border-bottom:1px solid #1f2937;white-space:pre}
    tr:last-child td{border-bottom:none}
  </style>
</head>
<body>
  <h1>&#x1f4a5; ${title.replace(/</g, "&lt;")}</h1>
  <p>${detail.replace(/</g, "&lt;")}</p>
  ${rows ? `<details open><summary>Stack trace</summary><table>${rows}</table></details>` : ""}
</body>
</html>`;
  return new Response(html, { status: 500, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

/** Core API app — no frontend routes, no listen. Used by server.ts and unit tests. */
export function createApp(jwtSecret: string) {
  return new Elysia()
    .onError(({ error, code, request }) => {
      if (code === "VALIDATION") {
        const first = [...error.all][0];
        return Response.json(
          { error: first?.message ?? error.message },
          { status: 422 },
        );
      }
      console.error(`[500] ${request.method} ${new URL(request.url).pathname}`, error);
      const isApi = new URL(request.url).pathname.startsWith("/api/");
      if (isApi) {
        return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
      }
      return errorPage(
        error instanceof Error ? error.constructor.name : "Internal Server Error",
        error instanceof Error ? error.message : String(error),
        error instanceof Error ? error.stack : undefined,
      );
    })
    .use(authPlugin(jwtSecret))
    .use(passkeyPlugin(jwtSecret))
    .use(apiPlugin(jwtSecret))
    .use(dockerPlugin(jwtSecret))
    .use(composePlugin(jwtSecret))
    .use(systemPlugin(jwtSecret))
    .use(filesPlugin(jwtSecret))
    .use(sambaPlugin(jwtSecret))
    .use(casaosPlugin(jwtSecret))
    .use(portsPlugin(jwtSecret))
    .use(bookmarksPlugin(jwtSecret))
    .use(appStorePlugin(jwtSecret))
    .get("/api/health", () => ({ status: "ok" }));
}

export type App = ReturnType<typeof createApp>;
