/**
 * Negative tests for /api/auth/setup and /api/auth/login.
 * Covers validation rejections, credential failures, and edge cases.
 *
 * Uses Eden Treaty against a live Elysia app instance — no server required.
 *
 * Run: bun test --bail tests/auth-negative.test.ts
 */
import { describe, test, expect, beforeAll } from "bun:test";
import { createTestClient, errMsg } from "./helpers";

const client = createTestClient();

const VALID_USER = "admin";
const VALID_PASS = "password123";

// Ensure admin exists before login tests — setup returns 403 if already created, that's fine.
beforeAll(async () => {
  await client.api.auth.setup.post({ username: VALID_USER, password: VALID_PASS });
});

// ─── Setup — username validation ──────────────────────────────────────────────

describe("POST /api/auth/setup — username validation", () => {

  test("too short (2 chars) → 422", async () => {
    const { response, error } = await client.api.auth.setup.post({ username: "ab", password: VALID_PASS });
    expect(response.status).toBe(422);
    expect(errMsg(error?.value)).toContain("Username");
  });

  test("too long (33 chars) → 422", async () => {
    const { response, error } = await client.api.auth.setup.post({ username: "a".repeat(33), password: VALID_PASS });
    expect(response.status).toBe(422);
    expect(errMsg(error?.value)).toContain("Username");
  });

  test("contains space → 422", async () => {
    const { response, error } = await client.api.auth.setup.post({ username: "my user", password: VALID_PASS });
    expect(response.status).toBe(422);
    expect(errMsg(error?.value)).toContain("Username");
  });

  test("contains @ → 422", async () => {
    const { response, error } = await client.api.auth.setup.post({ username: "user@host", password: VALID_PASS });
    expect(response.status).toBe(422);
    expect(errMsg(error?.value)).toContain("Username");
  });

  test("empty string → 422", async () => {
    const { response } = await client.api.auth.setup.post({ username: "", password: VALID_PASS });
    expect(response.status).toBe(422);
  });

});

// ─── Setup — password validation ──────────────────────────────────────────────

describe("POST /api/auth/setup — password validation", () => {

  test("too short (7 chars) → 422", async () => {
    const { response, error } = await client.api.auth.setup.post({ username: VALID_USER, password: "short7!" });
    expect(response.status).toBe(422);
    expect(errMsg(error?.value)).toContain("Password");
  });

  test("too long (33 chars) → 422", async () => {
    const { response, error } = await client.api.auth.setup.post({ username: VALID_USER, password: "a".repeat(33) });
    expect(response.status).toBe(422);
    expect(errMsg(error?.value)).toContain("Password");
  });

  test("contains space → 422", async () => {
    const { response, error } = await client.api.auth.setup.post({ username: VALID_USER, password: "pass word1!" });
    expect(response.status).toBe(422);
    expect(errMsg(error?.value)).toContain("Password");
  });

  test("empty string → 422", async () => {
    const { response } = await client.api.auth.setup.post({ username: VALID_USER, password: "" });
    expect(response.status).toBe(422);
  });

});

// ─── Setup — body edge cases ──────────────────────────────────────────────────

describe("POST /api/auth/setup — body edge cases", () => {

  test("already initialized → 403", async () => {
    const { response, error } = await client.api.auth.setup.post({ username: "other", password: VALID_PASS });
    expect(response.status).toBe(403);
    expect(errMsg(error?.value)).toContain("already exists");
  });

});

// ─── Login — credential failures ─────────────────────────────────────────────

describe("POST /api/auth/login — credential failures", () => {

  test("wrong password → 401", async () => {
    const { response, error } = await client.api.auth.login.post({ username: VALID_USER, password: "wrongpass1" });
    expect(response.status).toBe(401);
    expect(errMsg(error?.value)).toContain("Invalid credentials");
  });

  test("non-existent username → 401", async () => {
    const { response, error } = await client.api.auth.login.post({ username: "ghost", password: VALID_PASS });
    expect(response.status).toBe(401);
    expect(errMsg(error?.value)).toContain("Invalid credentials");
  });

  test("correct username, empty password → 422", async () => {
    const { response, error } = await client.api.auth.login.post({ username: VALID_USER, password: "" });
    expect(response.status).toBe(422);
    expect(errMsg(error?.value)).toContain("Password");
  });

  test("empty username → 422", async () => {
    const { response, error } = await client.api.auth.login.post({ username: "", password: VALID_PASS });
    expect(response.status).toBe(422);
    expect(errMsg(error?.value)).toContain("Username");
  });

});

// ─── Login — body edge cases ──────────────────────────────────────────────────

describe("POST /api/auth/login — body edge cases", () => {

  test("missing username field → 422", async () => {
    const { response } = await client.api.auth.login.post({ username: undefined as never, password: VALID_PASS });
    expect(response.status).toBe(422);
  });

  test("missing password field → 422", async () => {
    const { response } = await client.api.auth.login.post({ username: VALID_USER, password: undefined as never });
    expect(response.status).toBe(422);
  });

});
