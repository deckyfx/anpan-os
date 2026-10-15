import { test, expect, describe, beforeAll } from "bun:test";
import { createApp } from "../src/app";
import { TEST_JWT, loginAs } from "./helpers";

/**
 * How the app answers paths it does not serve.
 */

const app = createApp(TEST_JWT);
let cookie: string;

beforeAll(async () => { cookie = await loginAs(); });

const req = (method: string, path: string, headers: Record<string, string> = {}) =>
  app.handle(new Request(`http://localhost${path}`, { method, headers }));

describe("unknown routes", () => {
  test("an unknown API path is a 404 for every method, not a 500 or the SPA", async () => {
    for (const method of ["GET", "POST", "PUT", "DELETE"]) {
      const res = await req(method, "/api/does-not-exist");
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toContain("application/json");
    }
  });

  test("known API paths are unaffected by the /api/* fallback", async () => {
    expect((await req("GET", "/api/health")).status).toBe(200);
  });
});

