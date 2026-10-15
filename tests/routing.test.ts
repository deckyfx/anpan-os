import { test, expect, describe, beforeAll } from "bun:test";
import { createApp } from "../src/app";
import { TEST_JWT, loginAs } from "./helpers";

/**
 * How the app answers paths it does not serve, and how compose routes treat a stack name
 * that would leave the compose folder.
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

describe("compose stack names in the path", () => {
  // `..%2Fcomposes-x` resolved to a sibling of the compose folder and passed the old
  // prefix check; down, restart and logs had no other guard. Encoded, so the router
  // delivers it as one path segment.
  // (A bare ".." never reaches a handler: the URL parser collapses the segment first.)
  const escapes = ["..%2Fcomposes-x", "%2E%2E%2Fcomposes-x", "a%2Fb", "x.y"];

  for (const action of ["down", "restart"] as const) {
    test(`POST /stacks/:name/${action} refuses a name that is not plain`, async () => {
      for (const name of escapes) {
        const res = await req("POST", `/api/compose/stacks/${name}/${action}`, { cookie });
        expect(res.status).toBe(422);
      }
    });
  }

  test("GET /stacks/:name/logs refuses a name that is not plain", async () => {
    for (const name of escapes) {
      const res = await req("GET", `/api/compose/stacks/${name}/logs`, { cookie });
      expect(res.status).toBe(422);
    }
  });
});
