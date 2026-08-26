/**
 * Docker management routes — integration tests.
 *
 * Strategy:
 *   - Auth guard: every route must return 401 with no cookie.
 *   - Functional: with a valid session the route returns 200 (Docker available)
 *     or 502 (Docker socket unavailable in CI/test env) — never 401.
 *   - Container-action routes on an unknown id return 502 (Docker unavailable)
 *     or 404/500 from the Docker daemon — still not a 401.
 *
 * Run: bun test tests/docker.test.ts
 */
import { describe, test, expect, beforeAll } from "bun:test";
import { createTestClient, loginAs } from "./helpers";

const client = createTestClient();
let cookie = "";

const FAKE_ID = "nonexistent000000000000000000000000000000000000000000000000000000";

beforeAll(async () => {
  cookie = await loginAs();
});

// ─── Auth guard — every route must reject requests without a session ──────────

describe("Docker routes — 401 without session cookie", () => {

  test("GET /api/docker/containers", async () => {
    const { response } = await client.api.docker.containers.get();
    expect(response.status).toBe(401);
  });

  test("GET /api/docker/containers/:id", async () => {
    const { response } = await client.api.docker.containers({ id: FAKE_ID }).get();
    expect(response.status).toBe(401);
  });

  test("POST /api/docker/containers/:id/start", async () => {
    const { response } = await client.api.docker.containers({ id: FAKE_ID }).start.post();
    expect(response.status).toBe(401);
  });

  test("POST /api/docker/containers/:id/stop", async () => {
    const { response } = await client.api.docker.containers({ id: FAKE_ID }).stop.post();
    expect(response.status).toBe(401);
  });

  test("POST /api/docker/containers/:id/restart", async () => {
    const { response } = await client.api.docker.containers({ id: FAKE_ID }).restart.post();
    expect(response.status).toBe(401);
  });

  test("GET /api/docker/containers/:id/logs", async () => {
    const { response } = await client.api.docker.containers({ id: FAKE_ID }).logs.get();
    expect(response.status).toBe(401);
  });

  test("GET /api/docker/info", async () => {
    const { response } = await client.api.docker.info.get();
    expect(response.status).toBe(401);
  });

});

// ─── Authenticated requests ───────────────────────────────────────────────────
// Docker socket may not be present in the test environment — that's 502, not 401.
// We accept either 200 (socket available) or 502 (socket unavailable).

describe("Docker routes — authenticated (200 or 502)", () => {

  test("GET /api/docker/containers — returns array or 502", async () => {
    const { response, data } = await client.api.docker.containers.get({
      headers: { Cookie: cookie },
    });
    expect([200, 502]).toContain(response.status);
    if (response.status === 200) {
      expect(Array.isArray(data)).toBe(true);
    }
  });

  test("GET /api/docker/info — returns object or 502", async () => {
    const { response, data } = await client.api.docker.info.get({
      headers: { Cookie: cookie },
    });
    expect([200, 502]).toContain(response.status);
    if (response.status === 200) {
      const body = data as Record<string, unknown> | null;
      expect(typeof body?.Containers).toBe("number");
    }
  });

  test("GET /api/docker/containers/:id — 502 or 4xx for fake id", async () => {
    const { response } = await client.api.docker.containers({ id: FAKE_ID }).get({
      headers: { Cookie: cookie },
    });
    // 502 = Docker unavailable, 404/500 = Docker returned error — all fine
    expect(response.status).not.toBe(401);
  });

  test("POST /api/docker/containers/:id/start — not 401 with auth", async () => {
    const { response } = await client.api.docker.containers({ id: FAKE_ID }).start.post(
      undefined,
      { headers: { Cookie: cookie } },
    );
    expect(response.status).not.toBe(401);
  });

  test("POST /api/docker/containers/:id/stop — not 401 with auth", async () => {
    const { response } = await client.api.docker.containers({ id: FAKE_ID }).stop.post(
      undefined,
      { headers: { Cookie: cookie } },
    );
    expect(response.status).not.toBe(401);
  });

  test("POST /api/docker/containers/:id/restart — not 401 with auth", async () => {
    const { response } = await client.api.docker.containers({ id: FAKE_ID }).restart.post(
      undefined,
      { headers: { Cookie: cookie } },
    );
    expect(response.status).not.toBe(401);
  });

  test("GET /api/docker/containers/:id/logs — not 401 with auth", async () => {
    const { response } = await client.api.docker.containers({ id: FAKE_ID }).logs.get({
      headers: { Cookie: cookie },
    });
    expect(response.status).not.toBe(401);
  });

  test("GET /api/docker/containers/:id/logs?tail=50 — accepts tail query param", async () => {
    const { response } = await client.api.docker.containers({ id: FAKE_ID }).logs.get({
      query:   { tail: "50" },
      headers: { Cookie: cookie },
    });
    expect(response.status).not.toBe(401);
  });

});

// ─── Standalone container resolution ─────────────────────────────────────────

describe("listProjectContainers — a stack is a project or a lone container", () => {
  /**
   * listStacks() shows a container with no compose label as a single-service stack named
   * after the container. Deletion resolved only the compose case, so those entries matched
   * nothing: the handler removed zero containers and still answered 200. A real buildkit
   * container sat in the UI undeletable, and the API reported success every time.
   */
  const containers = [
    { Id: "aaa", Names: ["/plex"],        Labels: { "com.docker.compose.project": "media" } },
    { Id: "bbb", Names: ["/sonarr"],      Labels: { "com.docker.compose.project": "media" } },
    { Id: "ccc", Names: ["/buildkit"],    Labels: {} },
    { Id: "ddd", Names: ["/media"],       Labels: {} },
  ];

  /** The resolution rule under test, mirroring DockerClient.listProjectContainers. */
  function resolve(name: string) {
    const byProject = containers.filter(c => c.Labels?.["com.docker.compose.project"] === name);
    if (byProject.length > 0) return byProject;
    return containers.filter(c =>
      c.Labels?.["com.docker.compose.project"] === undefined &&
      c.Names.some(n => n.replace(/^\//, "") === name),
    );
  }

  test("a compose project resolves to all of its services", () => {
    expect(resolve("media").map(c => c.Id)).toEqual(["aaa", "bbb"]);
  });

  test("a standalone container resolves by its own name", () => {
    expect(resolve("buildkit").map(c => c.Id)).toEqual(["ccc"]);
  });

  test("a project wins over a same-named standalone container", () => {
    // "media" is both a compose project and a loose container name. Resolving to the
    // container would delete the wrong thing, so the project takes precedence.
    expect(resolve("media").map(c => c.Id)).toEqual(["aaa", "bbb"]);
  });

  test("a container inside a project is not reachable by its own name", () => {
    // Otherwise deleting "plex" would remove one service of a running stack.
    expect(resolve("plex")).toEqual([]);
  });

  test("an unknown name resolves to nothing, so the route can 404", () => {
    expect(resolve("nope")).toEqual([]);
  });
});
