import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestClient, loginAs } from "./helpers";

/**
 * The move route reports its outcome over SSE, and the client treats a final `ok` as
 * completion — for a cut it clears the clipboard on that event. Two bugs have come out of
 * that contract, in opposite directions: a successful move reported as a failure, and then
 * a failure that still ended in `ok`, which would clear the clipboard while the source was
 * still on disk. These pin the contract down: an error means no `ok`, and a batch is never
 * abandoned part-way through.
 */

let cookie: string;
let root: string;

/** Drain the SSE stream into the events the client actually branches on. */
async function runMove(sources: string[], destination: string) {
  const client = createTestClient();
  const { data } = await (client.api.files as unknown as {
    move: { post: (b: unknown, o: unknown) => Promise<{ data: unknown }> };
  }).move.post({ sources, destination }, { headers: { cookie } });

  const logs: string[] = [];
  const errors: string[] = [];
  let sawOk = false;

  for await (const event of data as AsyncIterable<{ data?: { log?: string; ok?: boolean; error?: string } }>) {
    const m = event.data;
    if (!m) continue;
    if (m.log !== undefined) logs.push(m.log);
    if (m.error !== undefined) errors.push(m.error);
    if (m.ok) sawOk = true;
  }
  return { logs, errors, sawOk };
}

beforeAll(async () => {
  cookie = await loginAs();
  root = mkdtempSync(join(tmpdir(), "anpan-move-"));
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("move", () => {
  test("a move that succeeds ends in ok, and the file is at the destination", async () => {
    const src = join(root, "ok-src");
    const dst = join(root, "ok-dst");
    Bun.spawnSync(["mkdir", "-p", src, dst]);
    await Bun.write(join(src, "song.mp3"), "audio");

    const { errors, sawOk } = await runMove([join(src, "song.mp3")], dst);

    expect(errors).toEqual([]);
    expect(sawOk).toBe(true);
    expect(existsSync(join(dst, "song.mp3"))).toBe(true);
    expect(existsSync(join(src, "song.mp3"))).toBe(false);
  });

  test("a missing source is named, and the batch does not end in ok", async () => {
    // A clipboard can outlive the files it names. Reporting `ok` here would clear the cut
    // clipboard on the client, presenting a move that never happened as complete.
    const dst = join(root, "missing-dst");
    Bun.spawnSync(["mkdir", "-p", dst]);

    const { errors, sawOk } = await runMove([join(root, "gone.mp3")], dst);

    expect(errors.some(e => e.includes("no longer exists"))).toBe(true);
    expect(sawOk).toBe(false);
  });

  test("one missing source does not abandon the rest of the batch", async () => {
    // The original bug returned on the first problem, leaving every later item unmoved
    // under a message that said the move had succeeded.
    const src = join(root, "batch-src");
    const dst = join(root, "batch-dst");
    Bun.spawnSync(["mkdir", "-p", src, dst]);
    await Bun.write(join(src, "first.mp3"), "a");
    await Bun.write(join(src, "third.mp3"), "c");

    const { errors, sawOk } = await runMove(
      [join(src, "first.mp3"), join(src, "second-gone.mp3"), join(src, "third.mp3")],
      dst,
    );

    expect(existsSync(join(dst, "first.mp3"))).toBe(true);
    expect(existsSync(join(dst, "third.mp3"))).toBe(true);   // reached despite the gap
    expect(errors.some(e => e.includes("second-gone.mp3"))).toBe(true);
    expect(sawOk).toBe(false);
  });
});
