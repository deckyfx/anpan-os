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

/**
 * `scheme://host[:port]` in canonical form, or null if it is not an origin.
 *
 * Built by URL, which lowercases and drops only the port the scheme implies — so
 * `https://h:443` and `https://h` are one origin, while `http://h:443` stays distinct.
 */
function normaliseOrigin(origin: string): string | null {
  try {
    const url = new URL(origin.trim());
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}

/**
 * The scheme the client used. A reverse proxy that terminates TLS talks plain HTTP to this
 * server while the browser's Origin says https, so the proxy's X-Forwarded-Proto comes first
 * — the same rule the session cookie's Secure flag follows.
 */
function clientScheme(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  if (forwarded === "http" || forwarded === "https") return forwarded;
  try { return new URL(request.url).protocol.replace(/:$/, ""); } catch { return "http"; }
}

/** The origin a Referer URL belongs to, or null if it is absent or unparseable. */
function originOfReferer(referer: string | null): string | null {
  if (!referer) return null;
  try { return new URL(referer).origin; } catch { return null; }
}

/**
 * Why this request must be refused as cross-site, or null to let it through.
 *
 * It passes when its origin — scheme, host and port — is the one the request was addressed
 * to: the client's scheme with `Host`, or with `X-Forwarded-Host` from a reverse proxy that
 * rewrites `Host`. Or when its origin appears in `allowedOrigins`. Trusting `X-Forwarded-Host` here is safe: a cross-site page cannot set
 * a custom header without a CORS preflight, and this server answers none.
 */
export function crossSiteRefusal(request: Request, allowedOrigins: readonly string[]): string | null {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return null;

  const origin = request.headers.get("origin") ?? originOfReferer(request.headers.get("referer"));
  if (origin === null) return null;                    // not sent by a browser page
  if (origin === "null") return "Request refused: it came from an opaque origin";

  const source = normaliseOrigin(origin);
  if (!source) return "Request refused: its Origin header is not a valid origin";

  // The whole origin, not the host alone: an http page on this hostname is a different
  // origin from the https server, even on the same port number.
  const scheme = clientScheme(request);
  const addressedTo = [request.headers.get("host"), request.headers.get("x-forwarded-host")?.split(",")[0]]
    .filter((h): h is string => !!h?.trim())
    .map(h => normaliseOrigin(`${scheme}://${h.trim()}`));
  if (addressedTo.includes(source)) return null;

  if (allowedOrigins.some(allowed => normaliseOrigin(allowed) === source)) return null;

  return `Request refused: it came from ${origin}, which is not this server. `
    + "If that is an address you use for anpan-os, add it to server.allowed_origins.";
}
