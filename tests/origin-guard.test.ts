import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app";
import { crossSiteRefusal } from "../src/lib/origin-check";
import { TEST_JWT, loginAs } from "./helpers";

/**
 * A page on another site could make a signed-in browser change things here: the session
 * cookie's SameSite policy was the only defence, and it is configurable down to "lax" or
 * "none". State-changing requests must now come from a page this server served, or from an
 * origin the config names.
 */

const EVIL = "https://evil.example";

const req = (method: string, headers: Record<string, string>) =>
  new Request("http://anpan.local:5000/api/x", { method, headers });

describe("crossSiteRefusal", () => {
  test("safe methods need no provenance", () => {
    for (const m of ["GET", "HEAD", "OPTIONS"]) expect(crossSiteRefusal(req(m, { origin: EVIL }), [])).toBeNull();
  });

  test("a request with neither Origin nor Referer is not from a browser page, and passes", () => {
    expect(crossSiteRefusal(req("POST", { host: "anpan.local:5000" }), [])).toBeNull();
  });

  test("another site's page is refused", () => {
    expect(crossSiteRefusal(req("POST", { host: "anpan.local:5000", origin: EVIL }), [])).toContain(EVIL);
  });

  test("Origin: null is refused, since an attacker can produce it on demand", () => {
    expect(crossSiteRefusal(req("POST", { host: "anpan.local:5000", origin: "null" }), [])).not.toBeNull();
  });

  test("a page served by this host passes, including with the scheme's default port spelled out", () => {
    // req() addresses http://anpan.local:5000, so that is this server's origin.
    expect(crossSiteRefusal(req("POST", { host: "anpan.local:5000", origin: "http://anpan.local:5000" }), [])).toBeNull();
    const https = { host: "anpan.example:443", "x-forwarded-proto": "https", origin: "https://anpan.example" };
    expect(crossSiteRefusal(req("PUT", https), [])).toBeNull();
  });

  test("the scheme is part of the origin: an http page is not the https server", () => {
    // Same hostname and port number, different origin. Comparing hosts alone let these pass.
    const httpsServer = { host: "anpan.example:443", "x-forwarded-proto": "https" };
    expect(crossSiteRefusal(req("POST", { ...httpsServer, origin: "http://anpan.example:443" }), [])).not.toBeNull();
    expect(crossSiteRefusal(req("POST", { host: "anpan.local:5000", origin: "https://anpan.local:5000" }), [])).not.toBeNull();
  });

  test("behind a proxy that rewrites Host, X-Forwarded-Host decides", () => {
    // The proxy terminates TLS: this server sees plain HTTP, X-Forwarded-Proto says https.
    const viaProxy = {
      host: "127.0.0.1:5000", "x-forwarded-host": "anpan.example", "x-forwarded-proto": "https",
      origin: "https://anpan.example",
    };
    expect(crossSiteRefusal(req("POST", viaProxy), [])).toBeNull();
  });

  test("a configured origin passes, compared without case or a trailing slash", () => {
    const rewritten = { host: "127.0.0.1:5000", origin: "https://anpan.example" };
    expect(crossSiteRefusal(req("POST", rewritten), [])).not.toBeNull();
    expect(crossSiteRefusal(req("POST", rewritten), ["HTTPS://ANPAN.EXAMPLE/"])).toBeNull();
  });

  test("Referer stands in for a missing Origin", () => {
    expect(crossSiteRefusal(req("DELETE", { host: "anpan.local:5000", referer: `${EVIL}/page` }), [])).not.toBeNull();
    expect(crossSiteRefusal(req("DELETE", { host: "anpan.local:5000", referer: "http://anpan.local:5000/files" }), [])).toBeNull();
  });

  test("an Origin that is not a valid origin is refused", () => {
    expect(crossSiteRefusal(req("POST", { host: "anpan.local:5000", origin: "not a url" }), [])).not.toBeNull();
  });
});

describe("every state-changing API route", () => {
  const app = createApp(TEST_JWT);

  test("refuses another site's page", async () => {
    // Sent without a cookie on purpose: a route the guard missed would then stop at the
    // session check with 401 rather than run -- and some of these restart or power off the
    // machine. Transform runs before both validation and the session check, so a covered
    // route answers 403 whatever the body or the cookie.
    const routes = (app as unknown as { routes: { method: string; path: string }[] }).routes
      .filter(r => r.path.startsWith("/api/") && !["GET", "HEAD", "OPTIONS"].includes(r.method));
    expect(routes.length).toBeGreaterThan(50);       // the enumeration itself must not go empty

    const uncovered: string[] = [];
    for (const r of routes) {
      const path = r.path.replace(/:[^/]+/g, "x").replace(/\*/g, "x");
      const res = await app.handle(new Request(`http://anpan.local:5000${path}`, {
        method: r.method,
        headers: { host: "anpan.local:5000", origin: EVIL, "content-type": "application/json" },
        body: "{}",
      }));
      if (res.status !== 403) uncovered.push(`${r.method} ${r.path} → ${res.status}`);
    }
    expect(uncovered).toEqual([]);
  });
});

describe("a signed-in browser", () => {
  const app = createApp(TEST_JWT);
  let cookie: string;
  let scratch: string;
  beforeAll(async () => { cookie = await loginAs(); scratch = mkdtempSync(join(tmpdir(), "anpan-origin-")); });
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  const mkdir = (path: string, origin: string) => app.handle(new Request("http://anpan.local:5000/api/files/mkdir", {
    method: "POST",
    headers: { cookie, host: "anpan.local:5000", origin, "content-type": "application/json" },
    body: JSON.stringify({ path }),
  }));

  test("cannot be made to change anything by another site, even with its session", async () => {
    const target = join(scratch, "forged");
    expect((await mkdir(target, EVIL)).status).toBe(403);
    expect(existsSync(target)).toBe(false);
  });

  test("still works from a page this server served", async () => {
    // The positive control: the guard must not refuse the UI itself.
    const target = join(scratch, "genuine");
    expect((await mkdir(target, "http://anpan.local:5000")).status).toBe(200);
    expect(existsSync(target)).toBe(true);
  });

  test("reads are unaffected, whatever their origin", async () => {
    const res = await app.handle(new Request("http://anpan.local:5000/api/system/info", {
      headers: { cookie, host: "anpan.local:5000", origin: EVIL },
    }));
    expect(res.status).toBe(200);
  });
});
