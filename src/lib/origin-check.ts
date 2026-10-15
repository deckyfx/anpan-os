/**
 * Refusing state-changing requests that another site's page sent.
 *
 * The session cookie's SameSite policy was the only defence against cross-site request
 * forgery, and it is configurable down to "lax" or "none" — which multi-hostname setups
 * need. This adds the check that does not depend on it: a request that changes something
 * must come from a page served by this server, or from an origin the config names.
 *
 * Browsers send `Origin` on every cross-site request that is not a GET or HEAD, and page
 * scripts cannot forge or remove it. A request with neither `Origin` nor `Referer` therefore
 * did not come from a browser page — a script, curl, the CLI — and cannot carry a victim's
 * session cross-site, so it is let through. `Origin: null` is the opposite: it is what a
 * sandboxed frame, a `data:` page or a cross-site redirect sends, and an attacker can
 * produce it on demand, so it is refused.
 */

/** Methods that must not change state, and so need no provenance. */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** `host[:port]`, lowercase, without the port a scheme implies. */
function normaliseHost(host: string): string {
  return host.trim().toLowerCase().replace(/:(80|443)$/, "");
}

/** `scheme://host[:port]`, lowercase, no trailing slash — the form `Origin` takes. */
function normaliseOrigin(origin: string): string {
  return origin.trim().toLowerCase().replace(/\/+$/, "");
}

/** The origin a Referer URL belongs to, or null if it is absent or unparseable. */
function originOfReferer(referer: string | null): string | null {
  if (!referer) return null;
  try { return new URL(referer).origin; } catch { return null; }
}

/**
 * Why this request must be refused as cross-site, or null to let it through.
 *
 * It passes when its origin's host is the one the request was addressed to — `Host`, or
 * `X-Forwarded-Host` from a reverse proxy that rewrites `Host` — or when its origin appears
 * in `allowedOrigins`. Trusting `X-Forwarded-Host` here is safe: a cross-site page cannot set
 * a custom header without a CORS preflight, and this server answers none.
 */
export function crossSiteRefusal(request: Request, allowedOrigins: readonly string[]): string | null {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return null;

  const origin = request.headers.get("origin") ?? originOfReferer(request.headers.get("referer"));
  if (origin === null) return null;                    // not sent by a browser page
  if (origin === "null") return "Request refused: it came from an opaque origin";

  let host: string;
  try { host = normaliseHost(new URL(origin).host); } catch {
    return "Request refused: its Origin header is not a valid origin";
  }

  const addressedTo = [request.headers.get("host"), request.headers.get("x-forwarded-host")?.split(",")[0]]
    .filter((h): h is string => !!h)
    .map(normaliseHost);
  if (addressedTo.includes(host)) return null;

  if (allowedOrigins.some(allowed => normaliseOrigin(allowed) === normaliseOrigin(origin))) return null;

  return `Request refused: it came from ${origin}, which is not this server. `
    + "If that is an address you use for anpan-os, add it to server.allowed_origins.";
}
