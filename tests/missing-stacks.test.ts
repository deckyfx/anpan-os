/**
 * Stacks anpan-os remembers that Docker no longer has, and forgetting them.
 *
 * The case behind this: btop was removed by hand with `docker compose down` and its folder
 * deleted. Its row stayed in `stacks` and its update results stayed in
 * `image_update_state`, and nothing in the UI could reach it, because the home page lists
 * only what Docker reports.
 */
import { test, expect, describe, beforeAll, beforeEach, afterEach, spyOn } from "bun:test";
import { findMissingStacks } from "../src/lib/missing-stacks";
import { StackStore } from "../src/stores/stack-store";
import { UpdateCheckStore } from "../src/stores/update-check-store";
import { DockerClient } from "../src/lib/docker";
import type { Stack } from "../src/db/schema";
import { createTestClient, loginAs } from "./helpers";

const row = (id: string, managed: boolean, title: string | null = null): Stack => ({
  id, title, icon: null, tagline: null, portMap: null, scheme: "http", indexPath: "/",
  mainService: null, address: null, note: null, openMode: null, managed, orderNo: null,
  updatedAt: new Date(0),
});

describe("findMissingStacks", () => {
  test("returns only rows with no live stack, installed ones first", () => {
    const rows = [row("sshlog", false), row("jellyfin", true), row("btop", true, "BTop"), row("mt-trial", false)];
    const missing = findMissingStacks(rows, new Set(["jellyfin"]), id => id === "mt-trial");

    expect(missing.map(m => m.id)).toEqual(["btop", "mt-trial", "sshlog"]);
    expect(missing[0]).toEqual({ id: "btop", title: "BTop", icon: null, managed: true, composeOnDisk: false });
    expect(missing.find(m => m.id === "mt-trial")?.composeOnDisk).toBe(true);
  });

  test("nothing is missing when every row is live", () => {
    expect(findMissingStacks([row("a", true)], new Set(["a"]), () => false)).toEqual([]);
  });
});

describe("StackStore.delete", () => {
  beforeEach(async () => { await UpdateCheckStore.purge(); });

  test("also drops the stack's update results, and only that stack's", async () => {
    await StackStore.upsert({ id: "gone-stack", managed: true });
    const run = await UpdateCheckStore.createRun(false, 2);
    await UpdateCheckStore.putResult(run.id, { stack: "gone-stack", image: "big-bear-btop", error: "Not found, or needs credentials" });
    await UpdateCheckStore.putResult(run.id, { stack: "kept-stack", image: "nginx" });

    await StackStore.delete("gone-stack");

    expect(await StackStore.findById("gone-stack")).toBeNull();
    expect((await UpdateCheckStore.allState()).map(r => r.stack)).toEqual(["kept-stack"]);
  });
});

describe("routes", () => {
  const client = createTestClient();
  let cookie = "";
  const spies: Array<{ mockRestore: () => void }> = [];

  beforeAll(async () => { cookie = await loginAs(); });
  afterEach(() => { while (spies.length) spies.pop()!.mockRestore(); });

  /** Pretend Docker holds exactly these containers for every project lookup. */
  const dockerHas = (containers: number) => {
    const fake = Array.from({ length: containers }, (_, i) => ({ Id: `c${i}`, Names: [`/c${i}`], Labels: {} }));
    spies.push(spyOn(DockerClient, "listProjectContainers").mockResolvedValue({ ok: true, data: fake } as never));
  };

  test("GET /stacks/missing lists a row Docker does not have", async () => {
    await StackStore.upsert({ id: "orphan-a", managed: true });
    spies.push(spyOn(DockerClient, "listStacks").mockResolvedValue({ ok: true, data: [] }));

    const { data, response } = await client.api.docker.stacks.missing.get({ headers: { cookie } });
    expect(response.status).toBe(200);
    expect((data as { stacks: Array<{ id: string }> }).stacks.map(s => s.id)).toContain("orphan-a");
  });

  test("GET /stacks/missing reports a failed Docker listing instead of calling everything missing", async () => {
    spies.push(spyOn(DockerClient, "listStacks").mockResolvedValue({ ok: false, error: "socket unavailable" } as never));
    const { response } = await client.api.docker.stacks.missing.get({ headers: { cookie } });
    expect(response.status).toBe(502);
  });

  test("forget removes the row and its update results", async () => {
    await StackStore.upsert({ id: "orphan-b", managed: true });
    const run = await UpdateCheckStore.createRun(false, 1);
    await UpdateCheckStore.putResult(run.id, { stack: "orphan-b", image: "x/y" });
    dockerHas(0);

    const { response } = await client.api.docker.stacks({ name: "orphan-b" }).forget.post(undefined, { headers: { cookie } });
    expect(response.status).toBe(200);
    expect(await StackStore.findById("orphan-b")).toBeNull();
    expect((await UpdateCheckStore.allState()).some(r => r.stack === "orphan-b")).toBe(false);
  });

  test("forget refuses while Docker still has containers for the stack", async () => {
    await StackStore.upsert({ id: "still-running", managed: true, title: "Keep me" });
    dockerHas(2);

    const { response } = await client.api.docker.stacks({ name: "still-running" }).forget.post(undefined, { headers: { cookie } });
    expect(response.status).toBe(409);
    expect((await StackStore.findById("still-running"))?.title).toBe("Keep me");
  });

  test("forget answers 404 for a stack anpan-os has no record of", async () => {
    dockerHas(0);
    const { response } = await client.api.docker.stacks({ name: "never-existed" }).forget.post(undefined, { headers: { cookie } });
    expect(response.status).toBe(404);
  });

  test("forget needs a session", async () => {
    const { response } = await client.api.docker.stacks({ name: "btop" }).forget.post();
    expect(response.status).toBe(401);
  });
});
