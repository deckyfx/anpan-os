/**
 * System stats route — integration tests.
 *
 * GET /api/system/stats reads whatever the host provides — /proc/stat and /proc/meminfo on
 * Linux, os.cpus() ticks and `vm_stat` on macOS — plus `df -Pk` on both. The assertions are
 * deliberately about plausibility rather than exact values, so the same suite holds on
 * either platform without knowing which one it is running on.
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

interface DiskMount {
  device: string;
  mount:  string;
  used:   number;
  total:  number;
}

interface SystemStats {
  cpu:      number;
  ramUsed:  number;
  ramTotal: number;
  /** Per-mount, since multi-disk support replaced the flat diskUsed/diskTotal pair. */
  disks:    DiskMount[];
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

  test("disks is a list of mounts, each with a positive total", async () => {
    const { data } = await client.api.system.stats.get({
      headers: { Cookie: cookie },
    });
    const stats = data as SystemStats | null;
    expect(Array.isArray(stats?.disks)).toBe(true);
    // No non-empty assertion: getDisk() keeps only /dev/-backed mounts, and a container
    // whose root is an overlay legitimately reports none.
    for (const d of stats!.disks) {
      expect(typeof d.total).toBe("number");
      expect(d.total).toBeGreaterThan(0);
    }
  });

  test("each mount reports used within its own total", async () => {
    const { data } = await client.api.system.stats.get({
      headers: { Cookie: cookie },
    });
    const stats = data as SystemStats | null;
    for (const d of stats!.disks) {
      expect(d.used).toBeGreaterThanOrEqual(0);
      expect(d.used).toBeLessThanOrEqual(d.total);
      expect(typeof d.mount).toBe("string");
    }
  });

});
