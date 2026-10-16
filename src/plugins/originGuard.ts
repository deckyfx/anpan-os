import { Elysia, status } from "elysia";
import { config } from "../config";
import { crossSiteRefusal } from "../lib/origin-check";

/**
 * Refuses state-changing requests sent by another site's page — see crossSiteRefusal.
 *
 * A transform hook, scoped to the plugin that uses it. Transform runs before body validation,
 * so a forged request is refused as cross-site rather than reported as a malformed body, and
 * before the session is resolved, so it is refused whoever's cookie it carries.
 *
 * Never install this, or any hook, globally: Elysia serves the web UI's HTML bundle natively
 * only for routes with no lifecycle hooks, and a global one makes every page come back as the
 * bundle's JSON description. Each API plugin takes it through authGuard, or uses it directly.
 */
export function originGuard() {
  return new Elysia({ name: "origin-guard" })
    .onTransform({ as: "scoped" }, ({ request }) => {
      const refusal = crossSiteRefusal(request, config.allowedOrigins);
      // Thrown, not returned: a transform hook's declared result is void, so a returned
      // response works only by accident and a later Elysia could silently drop it --
      // disabling this check without a sound. Throwing a status is the documented abort.
      if (refusal) throw status(403, { error: refusal });
    });
}
