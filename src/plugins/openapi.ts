import { Elysia } from "elysia";
import { openapi } from "@elysiajs/openapi";
import { authGuard } from "./authGuard";
// A JSON import is inlined by Bun's bundler, so the compiled binary carries the version it
// was built from without reading package.json off disk at run time.
import pkg from "../../package.json";

/** Where the machine-readable spec is served. */
export const OPENAPI_SPEC_PATH = "/api/openapi.json";

/**
 * Routes left out of the spec.
 *
 * - `/api/auth/*` (login, setup, logout, passkeys, account settings) is for the person at the
 *   browser, not for an API key, so documenting it would only invite calls that are refused.
 * - `/api/api-keys/*` is cookie-only by design: a key must not be able to mint or revoke keys.
 * - `/`, `/*` are the SPA's HTML routes, and `/api/*` is the catch-all 404 for unknown API
 *   paths; none of them is an endpoint.
 */
const EXCLUDED_PATHS: (string | RegExp)[] = [
  /^\/api\/auth(\/|$)/,
  /^\/api\/api-keys(\/|$)/,
  "/",
  "/*",
  "/api/*",
];

const DESCRIPTION = `HTTP API of anpan-os, a home-server dashboard (Docker stacks, containers, files, shares).

## Authentication

Send an API key as \`Authorization: Bearer anpan_<id>_<secret>\`. Keys are created in the web UI
under the menu's **API keys**. The browser session cookie (\`anpan_session\`) is accepted too.

Every key carries one scope:

- **read** — \`GET\` requests only, and nothing under \`/api/files\`.
- **operate** — everything \`read\` allows, plus writes to stacks, containers, compose,
  update checks, the app store, bookmarks and ports. Prune and stack deletion
  (\`DELETE /api/docker/stacks/{name}\`) still need \`full\`.
- **full** — everything (files, shares, self-update, restart, …) except the account routes and
  key management, which take the browser session only and are therefore absent from this
  document.

An invalid or expired key is answered with \`401\`; a valid key outside its scope with \`403\`.
The authoritative policy is \`src/lib/api-key-scope.ts\`.

## Streaming

The long-running endpoints (stack install, pull, repair, and logs) answer with
Server-Sent Events (\`text/event-stream\`) rather than a single JSON body: read the stream until it
closes, and treat a \`data\` event carrying \`error\` as failure.`;

/**
 * Serves the OpenAPI document at {@link OPENAPI_SPEC_PATH}, built from the routes' TypeBox
 * schemas, so a new route is documented the moment it is registered.
 *
 * No UI: `provider: null` mounts no Scalar/Swagger page, which would pull its assets from a CDN.
 *
 * Global hooks: none. The plugin adds a single GET route whose only hook (`error`) is local to
 * it, so it does not disturb Bun's native serving of the SPA's HTML bundle — which any global
 * lifecycle hook would.
 *
 * Behind {@link authGuard}, like every other API route. The repository is public, so the route
 * shapes are not secret; the guard is here because the document also lists exactly which
 * endpoints an installation exposes, and an agent reading it holds a key anyway. The plugin's
 * route is registered inside this guarded instance, so it is refused (401) without a session or
 * key the same way the routes it describes are. Which keys may read it is decided, like every
 * route's, by the scope table in lib/api-key-scope.ts — it should be readable by every scope.
 *
 * The plugin reads the routes of the root app lazily, on the first request, so it sees routes
 * registered after it — including any added by later `.use()` calls.
 */
export function openapiPlugin(jwtSecret: string) {
  return new Elysia({ name: "anpan-openapi" })
    .use(authGuard(jwtSecret))
    .use(
      openapi({
        path: "/api/openapi",
        specPath: OPENAPI_SPEC_PATH,
        provider: null,
        exclude: { paths: EXCLUDED_PATHS },
        documentation: {
          info: {
            title: "anpan-os API",
            version: pkg.version,
            description: DESCRIPTION,
          },
          components: {
            securitySchemes: {
              ApiKey: {
                type: "http",
                scheme: "bearer",
                description:
                  "API key in the form `anpan_<id>_<secret>`, created in the web UI under the menu's API keys.",
              },
            },
          },
          security: [{ ApiKey: [] }],
        },
      }),
    );
}
