/**
 * Compose stack routes — integration tests.
 *
 * Strategy:
 *   - Auth guard: every route must return 401 with no cookie.
 *   - Validation: POST /api/compose/stacks rejects bad names with 422.
 *   - Functional: with a valid session and valid input the route either:
 *       * Returns { ok: true } (Docker available, stack started)
 *       * Returns { ok: false, error: "..." } with 200 (docker compose failed)
 *       * Returns 500 if mkdir failed (permissions — test env uses a temp dir)
 *     In any case, the status is NOT 401 and NOT 422.
 *
 * Run: bun test tests/compose.test.ts
 */
import { describe, test, expect, beforeAll } from "bun:test";
import { createTestClient, errMsg, loginAs } from "./helpers";

const client = createTestClient();
let cookie = "";

beforeAll(async () => {
  cookie = await loginAs();
});

// ─── Auth guard ───────────────────────────────────────────────────────────────

describe("Compose routes — 401 without session cookie", () => {

  test("POST /api/compose/stacks", async () => {
    const { response } = await client.api.compose.stacks.post({
      name: "test-stack", content: "services:\n  web:\n    image: nginx",
    });
    expect(response.status).toBe(401);
  });

  test("POST /api/compose/stacks/:name/down", async () => {
    const { response } = await client.api.compose.stacks({ name: "test-stack" }).down.post();
    expect(response.status).toBe(401);
  });

  test("POST /api/compose/stacks/:name/restart", async () => {
    const { response } = await client.api.compose.stacks({ name: "test-stack" }).restart.post();
    expect(response.status).toBe(401);
  });

  test("GET /api/compose/stacks/:name/logs", async () => {
    const { response } = await client.api.compose.stacks({ name: "test-stack" }).logs.get();
    expect(response.status).toBe(401);
  });

});

// ─── Stack name validation ────────────────────────────────────────────────────

describe("POST /api/compose/stacks — name validation", () => {

  const VALID_CONTENT = "services:\n  web:\n    image: nginx:alpine";

  test("empty name → 422", async () => {
    const { response, error } = await client.api.compose.stacks.post(
      { name: "", content: VALID_CONTENT },
      { headers: { Cookie: cookie } },
    );
    expect(response.status).toBe(422);
    expect(errMsg(error?.value)).toBeTruthy();
  });

  test("name with spaces → 422", async () => {
    const { response, error } = await client.api.compose.stacks.post(
      { name: "my stack", content: VALID_CONTENT },
      { headers: { Cookie: cookie } },
    );
    expect(response.status).toBe(422);
    expect(errMsg(error?.value)).toContain("alphanumeric");
  });

  test("name with path separators → 422", async () => {
    const { response, error } = await client.api.compose.stacks.post(
      { name: "../evil", content: VALID_CONTENT },
      { headers: { Cookie: cookie } },
    );
    expect(response.status).toBe(422);
    expect(errMsg(error?.value)).toContain("alphanumeric");
  });

  test("name with dots → 422", async () => {
    const { response, error } = await client.api.compose.stacks.post(
      { name: "my.stack", content: VALID_CONTENT },
      { headers: { Cookie: cookie } },
    );
    expect(response.status).toBe(422);
    expect(errMsg(error?.value)).toContain("alphanumeric");
  });

  test("valid name with dashes → passes validation (not 422)", async () => {
    const { response } = await client.api.compose.stacks.post(
      { name: "my-test-stack", content: VALID_CONTENT },
      { headers: { Cookie: cookie } },
    );
    // 422 = validation failure; 200/500 = validation passed, system ran
    expect(response.status).not.toBe(422);
    expect(response.status).not.toBe(401);
  });

  test("valid name with underscores → passes validation (not 422)", async () => {
    const { response } = await client.api.compose.stacks.post(
      { name: "my_stack_2", content: VALID_CONTENT },
      { headers: { Cookie: cookie } },
    );
    expect(response.status).not.toBe(422);
    expect(response.status).not.toBe(401);
  });

});

// ─── Compose content validation ───────────────────────────────────────────────

describe("POST /api/compose/stacks — content validation", () => {

  test("empty content → 422", async () => {
    const { response } = await client.api.compose.stacks.post(
      { name: "test-stack", content: "" },
      { headers: { Cookie: cookie } },
    );
    expect(response.status).toBe(422);
  });

});

// ─── Authenticated operational calls ─────────────────────────────────────────
// These may fail (Docker/fs not available) but must not be 401.

describe("Compose routes — authenticated (not 401)", () => {

  test("POST /api/compose/stacks/:name/down — not 401 with auth", async () => {
    const { response } = await client.api.compose.stacks({ name: "no-such-stack" }).down.post(
      undefined,
      { headers: { Cookie: cookie } },
    );
    expect(response.status).not.toBe(401);
  });

  test("POST /api/compose/stacks/:name/restart — not 401 with auth", async () => {
    const { response } = await client.api.compose.stacks({ name: "no-such-stack" }).restart.post(
      undefined,
      { headers: { Cookie: cookie } },
    );
    expect(response.status).not.toBe(401);
  });

  test("GET /api/compose/stacks/:name/logs — not 401 with auth", async () => {
    const { response } = await client.api.compose.stacks({ name: "no-such-stack" }).logs.get({
      headers: { Cookie: cookie },
    });
    expect(response.status).not.toBe(401);
  });

});
