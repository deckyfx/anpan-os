/**
 * System stats route — integration tests.
 *
 * GET /api/system/stats reads /proc/stat, /proc/meminfo, and `df /` — all
 * available on Linux. The response must contain numeric fields in a plausible
 * range.
 *
 * Run: bun test tests/system.test.ts
 */
import { describe, test, expect, beforeAll } from "bun:test";
import { createTestClient, loginAs } from "./helpers";

const client = createTestClient();
let cookie = "";

beforeAll(async () => {
  cookie = await loginAs();
});

interface SystemStats {
  cpu:       number;
  ramUsed:   number;
  ramTotal:  number;
  diskUsed:  number;
  diskTotal: number;
}

// ─── Auth guard ───────────────────────────────────────────────────────────────

describe("System routes — 401 without session cookie", () => {

  test("GET /api/system/stats", async () => {
    const { response } = await client.api.system.stats.get();
    expect(response.status).toBe(401);
  });

});

// ─── Stats shape and plausibility ────────────────────────────────────────────

describe("GET /api/system/stats — returns plausible metrics", () => {

  test("returns 200 with stats object", async () => {
    const { response, data } = await client.api.system.stats.get({
      headers: { Cookie: cookie },
    });
    expect(response.status).toBe(200);
    expect(data).toBeTruthy();
  });

  test("cpu is a number between 0 and 100", async () => {
    const { data } = await client.api.system.stats.get({
      headers: { Cookie: cookie },
    });
    const stats = data as SystemStats | null;
    expect(typeof stats?.cpu).toBe("number");
    expect(stats!.cpu).toBeGreaterThanOrEqual(0);
    expect(stats!.cpu).toBeLessThanOrEqual(100);
  });

  test("ramTotal is greater than 0", async () => {
    const { data } = await client.api.system.stats.get({
      headers: { Cookie: cookie },
    });
    const stats = data as SystemStats | null;
    expect(typeof stats?.ramTotal).toBe("number");
    expect(stats!.ramTotal).toBeGreaterThan(0);
  });

  test("ramUsed is between 0 and ramTotal", async () => {
    const { data } = await client.api.system.stats.get({
      headers: { Cookie: cookie },
    });
    const stats = data as SystemStats | null;
    expect(stats!.ramUsed).toBeGreaterThanOrEqual(0);
    expect(stats!.ramUsed).toBeLessThanOrEqual(stats!.ramTotal);
  });

  test("diskTotal is greater than 0", async () => {
    const { data } = await client.api.system.stats.get({
      headers: { Cookie: cookie },
    });
    const stats = data as SystemStats | null;
    expect(typeof stats?.diskTotal).toBe("number");
    expect(stats!.diskTotal).toBeGreaterThan(0);
  });

  test("diskUsed is between 0 and diskTotal", async () => {
    const { data } = await client.api.system.stats.get({
      headers: { Cookie: cookie },
    });
    const stats = data as SystemStats | null;
    expect(stats!.diskUsed).toBeGreaterThanOrEqual(0);
    expect(stats!.diskUsed).toBeLessThanOrEqual(stats!.diskTotal);
  });

});
