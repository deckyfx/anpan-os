import { test, expect, describe, beforeEach } from "bun:test";
import { UpdateCheckStore } from "../src/stores/update-check-store";

beforeEach(async () => {
  await UpdateCheckStore.purge();
});

describe("runs", () => {
  test("a new run starts as running and is found by runningRun()", async () => {
    const run = await UpdateCheckStore.createRun(true, 46);
    expect(run.status).toBe("running");
    expect(run.total).toBe(46);
    expect(run.auto).toBe(true);
    expect((await UpdateCheckStore.runningRun())?.id).toBe(run.id);
  });

  test("progress is recorded and finishing clears the running state", async () => {
    const run = await UpdateCheckStore.createRun(false, 10);
    await UpdateCheckStore.recordProgress(run.id, 4, 2, 1);

    const mid = await UpdateCheckStore.findRun(run.id);
    expect(mid).toMatchObject({ completed: 4, updatesFound: 2, getFallbacks: 1 });

    await UpdateCheckStore.finishRun(run.id, "done");
    expect(await UpdateCheckStore.runningRun()).toBeNull();
    expect((await UpdateCheckStore.findRun(run.id))?.finishedAt).not.toBeNull();
  });

  test("lastFullRun ignores scoped runs, so one stack cannot look like the whole library", async () => {
    const full = await UpdateCheckStore.createRun(false, 45);
    await UpdateCheckStore.finishRun(full.id, "done");

    const scoped = await UpdateCheckStore.createRun(false, 4, "stash");
    await UpdateCheckStore.finishRun(scoped.id, "done");

    // lastRun sees the scoped one; the staleness gate must not, or checking a single
    // stack regularly would suppress full sweeps indefinitely.
    expect((await UpdateCheckStore.lastRun())?.id).toBe(scoped.id);
    expect((await UpdateCheckStore.lastFullRun())?.id).toBe(full.id);
  });

  test("orphaned runs are marked interrupted, so single-flight is not wedged forever", async () => {
    await UpdateCheckStore.createRun(false, 5);
    await UpdateCheckStore.createRun(false, 5);

    expect(await UpdateCheckStore.markOrphansInterrupted()).toBe(2);
    expect(await UpdateCheckStore.runningRun()).toBeNull();
  });
});

describe("firstSeenAt", () => {
  const img = { stack: "komga", image: "gotson/komga:latest" };

  test("is set when an update first appears", async () => {
    const run = await UpdateCheckStore.createRun(false, 1);
    await UpdateCheckStore.putResult(run.id, { ...img, hasUpdate: true, remoteDigest: "sha256:a", localDigest: "sha256:b" });

    const [row] = await UpdateCheckStore.allState();
    expect(row?.hasUpdate).toBe(true);
    expect(row?.firstSeenAt).not.toBeNull();
  });

  test("survives later sweeps — the age of an update is not reset each check", async () => {
    const run = await UpdateCheckStore.createRun(false, 1);
    await UpdateCheckStore.putResult(run.id, { ...img, hasUpdate: true, remoteDigest: "sha256:a", localDigest: "sha256:b" });
    const first = (await UpdateCheckStore.allState())[0]?.firstSeenAt;

    // A later sweep sees the same outstanding update.
    const run2 = await UpdateCheckStore.createRun(false, 1);
    await UpdateCheckStore.putResult(run2.id, { ...img, hasUpdate: true, remoteDigest: "sha256:a", localDigest: "sha256:b" });

    const after = (await UpdateCheckStore.allState())[0];
    expect(after?.firstSeenAt?.getTime()).toBe(first?.getTime());
    expect(after?.runId).toBe(run2.id);
  });

  test("is cleared once the digests agree again", async () => {
    const run = await UpdateCheckStore.createRun(false, 1);
    await UpdateCheckStore.putResult(run.id, { ...img, hasUpdate: true, remoteDigest: "sha256:a", localDigest: "sha256:b" });
    await UpdateCheckStore.putResult(run.id, { ...img, hasUpdate: false, remoteDigest: "sha256:a", localDigest: "sha256:a" });

    const [row] = await UpdateCheckStore.allState();
    expect(row?.hasUpdate).toBe(false);
    expect(row?.firstSeenAt).toBeNull();
  });
});

describe("state", () => {
  test("upsert keeps one row per (stack, image), not one per sweep", async () => {
    const run = await UpdateCheckStore.createRun(false, 2);
    await UpdateCheckStore.putResult(run.id, { stack: "s", image: "a:1", hasUpdate: false });
    await UpdateCheckStore.putResult(run.id, { stack: "s", image: "a:1", hasUpdate: true });
    await UpdateCheckStore.putResult(run.id, { stack: "s", image: "b:1", hasUpdate: false });

    expect((await UpdateCheckStore.allState()).length).toBe(2);
    expect((await UpdateCheckStore.outdated()).length).toBe(1);
  });

  test("skipped and errored images are distinguishable from 'no update'", async () => {
    const run = await UpdateCheckStore.createRun(false, 2);
    await UpdateCheckStore.putResult(run.id, { stack: "s", image: "pinned@sha256:x", skippedReason: "pinned to a digest" });
    await UpdateCheckStore.putResult(run.id, { stack: "s", image: "broken:1", error: "Registry returned 500" });

    const rows = await UpdateCheckStore.allState();
    expect(rows.find(r => r.image === "pinned@sha256:x")?.skippedReason).toContain("digest");
    expect(rows.find(r => r.image === "broken:1")?.error).toContain("500");
    // Neither counts as an update.
    expect((await UpdateCheckStore.outdated()).length).toBe(0);
  });

  test("retainOnly drops images that no longer exist", async () => {
    const run = await UpdateCheckStore.createRun(false, 2);
    await UpdateCheckStore.putResult(run.id, { stack: "keep", image: "a:1" });
    await UpdateCheckStore.putResult(run.id, { stack: "gone", image: "b:1" });

    await UpdateCheckStore.retainOnly([{ stack: "keep", image: "a:1" }]);

    const rows = await UpdateCheckStore.allState();
    expect(rows.length).toBe(1);
    expect(rows[0]?.stack).toBe("keep");
  });
});

describe("purge", () => {
  test("removes runs and results, and reports what it removed", async () => {
    const run = await UpdateCheckStore.createRun(false, 1);
    await UpdateCheckStore.putResult(run.id, { stack: "s", image: "a:1", hasUpdate: true });

    const removed = await UpdateCheckStore.purge();
    expect(removed.runs).toBeGreaterThanOrEqual(1);
    expect(removed.results).toBe(1);
    expect(await UpdateCheckStore.allState()).toEqual([]);
    expect(await UpdateCheckStore.lastRun()).toBeNull();
  });
});
