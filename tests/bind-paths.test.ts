import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { judgeBindPath } from "../src/lib/bind-paths";
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpathSync } from "node:fs";

/**
 * These guards are the only thing between a checkbox and irreversible data loss, so the
 * cases below are the ones that would actually destroy something: a shared root, a
 * symlink escaping the files root, and a directory another stack also mounts.
 */

let base: string;
let deep: string;

beforeAll(() => {
  // realpath the temp dir: macOS and some Linux setups symlink /tmp, and the guards
  // compare canonical paths.
  base = realpathSync(mkdtempSync(join(tmpdir(), "anpan-binds-")));
  deep = join(base, "AppData", "myapp");
  mkdirSync(deep, { recursive: true });
  writeFileSync(join(deep, "data.db"), "x");
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("judgeBindPath — refusals", () => {
  test("infrastructure mounts are never deletable", async () => {
    const v = await judgeBindPath("/var/run/docker.sock", new Set());
    expect(v.deletable).toBe(false);
    expect(v.deletable === false && v.reason).toContain("System mount");
  });

  test.each(["/", "/etc", "/var/lib", "/DATA", "/DATA/AppData"])(
    "%p is refused as a shared system directory",
    async (p) => {
      const v = await judgeBindPath(p, new Set());
      expect(v.deletable).toBe(false);
    },
  );

  test("a path that no longer exists is refused rather than assumed safe", async () => {
    const v = await judgeBindPath(join(base, "gone"), new Set());
    expect(v.deletable).toBe(false);
    expect(v.deletable === false && v.reason).toContain("no longer exists");
  });

  test("a directory another stack also mounts is refused", async () => {
    const v = await judgeBindPath(deep, new Set([deep]));
    expect(v.deletable).toBe(false);
    expect(v.deletable === false && v.reason).toContain("another stack");
  });

  test("a parent of another stack's directory is refused — deleting it takes the child", async () => {
    const parent = join(base, "AppData");
    const siblingData = join(parent, "otherapp");
    mkdirSync(siblingData, { recursive: true });

    const v = await judgeBindPath(parent, new Set([siblingData]));
    expect(v.deletable).toBe(false);
    expect(v.deletable === false && v.reason).toContain("another stack's data");
  });

  test("a path inside another stack's mount is refused", async () => {
    // The reverse of the parent case, and easy to miss: the strings are not equal and the
    // candidate does not contain the other, but deleting it still takes that stack's data.
    const shared = join(base, "AppData", "shared");
    const child  = join(shared, "db");
    mkdirSync(child, { recursive: true });

    const v = await judgeBindPath(child, new Set([shared]));
    expect(v.deletable).toBe(false);
    expect(v.deletable === false && v.reason).toContain("Inside another stack");
  });

  test("a symlink escaping the files root is refused", async () => {
    // A files root is required for this to mean anything: with "/" nothing is outside it.
    // The link sits inside the root, so the lexical prefix check used elsewhere would
    // pass it — only canonicalisation catches the escape.
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "anpan-outside-")));
    const link = join(base, "AppData", "escape");
    symlinkSync(outside, link);
    try {
      const v = await judgeBindPath(link, new Set(), base);
      expect(v.deletable).toBe(false);
      expect(v.deletable === false && v.reason).toContain("Outside the configured files root");
    } finally {
      rmSync(link, { force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("judgeBindPath — allowed", () => {
  test("an ordinary app data directory is deletable", async () => {
    const v = await judgeBindPath(deep, new Set());
    expect(v.deletable).toBe(true);
    expect(v.deletable === true && v.canonical).toBe(deep);
  });

  test("an unrelated stack's paths do not block it", async () => {
    const v = await judgeBindPath(deep, new Set(["/somewhere/else"]));
    expect(v.deletable).toBe(true);
  });

  test("traversal cannot disguise a shallow path as a deep one", async () => {
    // Literally this string is four segments long; canonically it is the root itself,
    // and the depth rule runs on the canonical form.
    const sneaky = join(base, "AppData", "myapp", "..", "..");
    const v = await judgeBindPath(sneaky, new Set(), base);
    expect(v.deletable).toBe(false);
    expect(v.deletable === false && v.reason).toContain("Too close to the filesystem root");
  });

  test("depth is enforced against the configured root", async () => {
    // One segment below the root is not enough; two is.
    const shallow = join(base, "AppData");
    expect((await judgeBindPath(shallow, new Set(), base)).deletable).toBe(false);
    expect((await judgeBindPath(deep, new Set(), base)).deletable).toBe(true);
  });
});
