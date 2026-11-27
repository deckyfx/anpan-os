import { test, expect, describe, beforeAll } from "bun:test";
import { createApp } from "../src/app";
import { TEST_JWT, loginAs } from "./helpers";

/**
 * The OpenAPI document at /api/openapi.json — what an API-key client reads to learn the API.
 *
 * In-process only: this cannot see whether the plugin disturbs Bun's native serving of the
 * SPA bundle in a compiled binary (a global hook would). That was checked against a built
 * binary when the plugin was added; the plugin registers no global hooks.
 */

type Spec = {
  openapi: string;
  info: { title: string; version: string; description?: string };
  paths: Record<string, Record<string, unknown>>;
  components?: { securitySchemes?: Record<string, { type: string; scheme?: string }> };
  security?: Record<string, string[]>[];
};

const app = createApp(TEST_JWT);
let cookie: string;
let spec: Spec;

beforeAll(async () => {
  cookie = await loginAs();
  const res = await app.handle(new Request("http://localhost/api/openapi.json", { headers: { cookie } }));
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("application/json");
  spec = (await res.json()) as Spec;
});

describe("GET /api/openapi.json", () => {
  test("requires a session or key, like the routes it describes", async () => {
    const res = await app.handle(new Request("http://localhost/api/openapi.json"));
    expect(res.status).toBe(401);
  });

  test("is an OpenAPI 3 document carrying the package version", async () => {
    expect(spec.openapi).toMatch(/^3\./);
    const pkg = (await Bun.file("package.json").json()) as { version: string };
    expect(spec.info.version).toBe(pkg.version);
  });

  test("declares the bearer API-key scheme and applies it globally", () => {
    expect(spec.components?.securitySchemes?.ApiKey).toMatchObject({ type: "http", scheme: "bearer" });
    expect(spec.security).toContainEqual({ ApiKey: [] });
  });

  test("documents the API routes", () => {
    expect(spec.paths["/api/docker/stacks"]?.get).toBeDefined();
    expect(spec.paths["/api/health"]?.get).toBeDefined();
  });

  test("a route with a declared query schema lists its parameters", () => {
    const op = spec.paths["/api/compose/tags"]?.get as
      | { parameters?: { name: string; in: string; required?: boolean }[] }
      | undefined;
    expect(op?.parameters).toContainEqual(expect.objectContaining({ name: "image", in: "query", required: true }));
  });

  test("leaves out account routes, key management, the SPA and itself", () => {
    const paths = Object.keys(spec.paths);
    expect(paths).not.toContain("/api/auth/login");
    expect(paths.some((p) => p.startsWith("/api/auth"))).toBe(false);
    expect(paths.some((p) => p.startsWith("/api/api-keys"))).toBe(false);
    expect(paths).not.toContain("/");
    expect(paths).not.toContain("/*");
    expect(paths).not.toContain("/api/*");
    expect(paths).not.toContain("/api/openapi.json");
  });

  test("mounts no interactive UI", async () => {
    for (const path of ["/api/openapi", "/openapi", "/swagger"]) {
      const res = await app.handle(new Request(`http://localhost${path}`, { headers: { cookie } }));
      expect(res.headers.get("content-type") ?? "").not.toContain("text/html");
    }
  });
});
