/**
 * The image tag picker's lookup.
 *
 * It used to send every image to Docker Hub's API, so `ghcr.io/atuinsh/atuin` was read as
 * the Hub repository `ghcr.io/atuinsh` and the picker always said "Docker Hub returned 404".
 */
import { test, expect, describe, afterEach, spyOn } from "bun:test";
import { listTags, nextPage, sortTagsNewestFirst } from "../src/lib/registry";
import type { CredentialSet } from "../src/lib/docker-credentials";

type Handler = (url: URL, init: RequestInit | undefined) => Response;

let fetchSpy: { mockRestore: () => void; mock: { calls: unknown[][] } } | null = null;
afterEach(() => { fetchSpy?.mockRestore(); fetchSpy = null; });

/** Route every fetch through `handler`, recording the URLs asked for. */
function serve(handler: Handler): string[] {
  const seen: string[] = [];
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    seen.push(url.href);
    return handler(url, init);
  }) as typeof fetch);
  return seen;
}

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { ...init, headers: { "content-type": "application/json", ...init.headers } });

const challenge = (registry: string) => new Response(null, {
  status: 401,
  headers: { "www-authenticate": `Bearer realm="https://${registry}/token",service="${registry}"` },
});

describe("listTags — Docker Hub", () => {
  test("an official image is read from library/", async () => {
    const seen = serve(() => json({ results: [{ name: "1.29", last_updated: "2026-11-01T00:00:00Z" }] }));
    const result = await listTags("nginx");

    expect(result).toEqual({ ok: true, tags: [{ name: "1.29", updated: "2026-11-01T00:00:00Z" }] });
    expect(seen[0]).toStartWith("https://hub.docker.com/v2/repositories/library/nginx/tags");
  });

  test("docker.io/ written out is still Docker Hub", async () => {
    const seen = serve(() => json({ results: [] }));
    await listTags("docker.io/jellyfin/jellyfin");
    expect(seen[0]).toStartWith("https://hub.docker.com/v2/repositories/jellyfin/jellyfin/tags");
  });

  test("a missing repository says so, rather than reporting a bare status", async () => {
    serve(() => new Response(null, { status: 404 }));
    const result = await listTags("bigbeartechworld/big-bear-btop");
    expect(result).toEqual({
      ok: false, reason: "not-found",
      error: "Docker Hub has no public repository named bigbeartechworld/big-bear-btop",
    });
  });

  test("a private repository is read through the registry with the docker login", async () => {
    const creds: CredentialSet = { for: () => ({ username: "u", password: "p" }), helperOnly: [] };
    serve((url, init) => {
      if (url.host === "hub.docker.com") return new Response(null, { status: 404 });
      if (url.host === "auth.docker.io") {
        expect(new Headers(init?.headers).get("authorization")).toStartWith("Basic ");
        return json({ token: "t" });
      }
      if (new Headers(init?.headers).get("authorization") !== "Bearer t") {
        return new Response(null, { status: 401, headers: {
          "www-authenticate": 'Bearer realm="https://auth.docker.io/token",service="registry.docker.io"',
        } });
      }
      return json({ tags: ["1.0", "2.0"] });
    });

    const result = await listTags("someone/private-app", { credentials: creds });
    expect(result).toEqual({ ok: true, tags: [{ name: "2.0", updated: null }, { name: "1.0", updated: null }] });
  });
});

describe("listTags — other registries", () => {
  test("ghcr.io is asked directly, with an anonymous token, not sent to Docker Hub", async () => {
    const seen = serve((url, init) => {
      if (url.pathname === "/token") return json({ token: "anon" });
      if (new Headers(init?.headers).get("authorization") !== "Bearer anon") return challenge("ghcr.io");
      return json({ tags: ["18.21.0", "18.3.0", "18.25.1", "latest", `sha256-${"a".repeat(64)}.sig`] });
    });

    const result = await listTags("ghcr.io/atuinsh/atuin");
    expect(seen.some(u => u.includes("hub.docker.com"))).toBe(false);
    expect(seen.some(u => u.startsWith("https://ghcr.io/v2/atuinsh/atuin/tags/list"))).toBe(true);
    // Newest version first, and the cosign signature is not offered as a tag.
    expect(result.ok && result.tags.map(t => t.name)).toEqual(["latest", "18.25.1", "18.21.0", "18.3.0"]);
  });

  test("a registry using Basic auth gets the docker login, not the token flow", async () => {
    const creds: CredentialSet = { for: (r) => r === "registry.example.com" ? { username: "u", password: "p" } : null, helperOnly: [] };
    serve((url, init) => {
      const auth = new Headers(init?.headers).get("authorization");
      if (auth !== `Basic ${btoa("u:p")}`) {
        return new Response(null, { status: 401, headers: { "www-authenticate": 'Basic realm="Registry Realm"' } });
      }
      return json({ tags: ["1.0"] });
    });
    expect(await listTags("registry.example.com/team/app", { credentials: creds }))
      .toEqual({ ok: true, tags: [{ name: "1.0", updated: null }] });
  });

  test("follows Link pagination on the registry's own origin", async () => {
    serve((url) => url.searchParams.get("last")
      ? json({ tags: ["b"] })
      : json({ tags: ["a"] }, { headers: { link: '</v2/x/y/tags/list?last=a&n=1000>; rel="next"' } }));

    const result = await listTags("quay.io/x/y");
    expect(result.ok && result.tags.map(t => t.name).sort()).toEqual(["a", "b"]);
  });

  test("an unknown repository is reported as not found", async () => {
    serve(() => new Response(null, { status: 404 }));
    expect(await listTags("ghcr.io/nobody/nothing")).toMatchObject({ ok: false, reason: "not-found" });
  });

  test("an unparseable name is refused before anything is fetched", async () => {
    const seen = serve(() => json({}));
    expect(await listTags("../etc/passwd")).toMatchObject({ ok: false, reason: "invalid" });
    expect(seen).toEqual([]);
  });
});

describe("helpers", () => {
  test("version-style tags sort numerically, newest first", () => {
    expect(sortTagsNewestFirst(["1.9", "1.10", "1.2"])).toEqual(["1.10", "1.9", "1.2"]);
  });

  test("moving tags first, then versions, other names, and commit hashes last", () => {
    // Roughly atuin's tags as ghcr returns them: oldest first, hashes mixed in.
    const tags = ["ffeff77", "18.3.0", "main", "v18.13.3", "18.24.0-beta.2", "9933220", "18.24.0",
      "latest", "ffeff77-aarch64", "18.25.1", "2026112315", "2026111501"];
    expect(sortTagsNewestFirst(tags)).toEqual([
      "latest", "main",
      "18.25.1", "18.24.0", "18.24.0-beta.2", "v18.13.3", "18.3.0",
      // Bare numbers: date builds and digit-only hashes cannot be told apart, so they go
      // after the releases, highest first.
      "2026112315", "2026111501", "9933220",
      "ffeff77", "ffeff77-aarch64",
    ]);
  });

  test("a next-page link to another host is not followed", () => {
    const current = "https://ghcr.io/v2/x/tags/list?n=1000";
    expect(nextPage('<https://evil.example/v2/x/tags/list>; rel="next"', current)).toBeNull();
    expect(nextPage('</v2/x/tags/list?last=a>; rel="next"', current)).toBe("https://ghcr.io/v2/x/tags/list?last=a");
    // Query-only targets stay on the endpoint being paged, not the registry root.
    expect(nextPage('<?last=b&n=1000>; rel="next"', current)).toBe("https://ghcr.io/v2/x/tags/list?last=b&n=1000");
    expect(nextPage(null, current)).toBeNull();
  });
});
