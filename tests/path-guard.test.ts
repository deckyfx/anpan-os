import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isWithinAny, resolveEntryWithin, resolveWithin } from "../src/lib/path-guard";

/**
 * Once `files.root` is narrowed below "/", it is the boundary between what the file manager
 * may touch and the rest of the host. A string-prefix check alone let a symlink inside the
 * root lead straight out of it. These pin down both rules on the decision functions
 * themselves, against a scratch tree, so a regression fails here rather than exposing a host.
 *
 *   base/
 *     root/                 ← the files root
 *       inside/a.txt
 *       escape      → base/outside        (a directory link that leaves the root)
 *       secret-link → base/outside/secret.txt
 *       inner-link  → root/inside         (a link that stays inside)
 *     outside/secret.txt
 *     root-alias  → base/root             (the root itself, reached through a link)
 */

let base: string;
let root: string;

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "anpan-guard-")));
  root = join(base, "root");
  mkdirSync(join(root, "inside"), { recursive: true });
  mkdirSync(join(base, "outside"));
  writeFileSync(join(root, "inside", "a.txt"), "a");
  writeFileSync(join(base, "outside", "secret.txt"), "secret");
  symlinkSync(join(base, "outside"), join(root, "escape"));
  symlinkSync(join(base, "outside", "secret.txt"), join(root, "secret-link"));
  symlinkSync(join(root, "inside"), join(root, "inner-link"));
  symlinkSync(root, join(base, "root-alias"));
});

afterAll(() => rmSync(base, { recursive: true, force: true }));

const allowed = (fn: () => string) => expect(fn).not.toThrow();
const refused = (fn: () => string) => expect(fn).toThrow("Forbidden");

describe("resolveWithin — going into a path", () => {
  test("ordinary paths inside the root are allowed, and returned as written", () => {
    expect(resolveWithin(join(root, "inside", "a.txt"), root)).toBe(join(root, "inside", "a.txt"));
    allowed(() => resolveWithin(root, root));
  });

  test("a directory link that leaves the root is refused, and so is anything beneath it", () => {
    refused(() => resolveWithin(join(root, "escape"), root));
    refused(() => resolveWithin(join(root, "escape", "secret.txt"), root));
  });

  test("a file link that leaves the root is refused", () => {
    refused(() => resolveWithin(join(root, "secret-link"), root));
  });

  test("a new path beneath an escaping link is refused before it exists", () => {
    // mkdir, write and upload name paths that do not exist yet; the link above them decides.
    refused(() => resolveWithin(join(root, "escape", "new-folder", "new.txt"), root));
  });

  test("a new path beneath an ordinary folder is allowed", () => {
    allowed(() => resolveWithin(join(root, "inside", "new-folder", "new.txt"), root));
  });

  test("a link that stays inside the root is allowed", () => {
    allowed(() => resolveWithin(join(root, "inner-link", "a.txt"), root));
  });

  test("spelling escapes are still refused", () => {
    refused(() => resolveWithin(join(root, "..", "outside"), root));
    refused(() => resolveWithin(`${root}-sibling/file`, root));   // shares the name prefix
  });

  test("a root configured through a link still contains what is beneath it", () => {
    const alias = join(base, "root-alias");
    allowed(() => resolveWithin(join(alias, "inside", "a.txt"), alias));
    refused(() => resolveWithin(join(alias, "escape"), alias));
  });

  test("with the root at / there is nothing to escape", () => {
    allowed(() => resolveWithin(join(root, "escape", "secret.txt"), "/"));
  });
});

describe("resolveEntryWithin — acting on an entry as itself", () => {
  test("a link that leaves the root can itself be deleted or renamed", () => {
    // These act on the link, not its target. Refusing them would leave a dangerous link
    // impossible to remove — the first thing anyone would want to do with it.
    allowed(() => resolveEntryWithin(join(root, "escape"), root));
    allowed(() => resolveEntryWithin(join(root, "secret-link"), root));
  });

  test("an entry reached through an escaping link is still refused", () => {
    // Only the last segment is taken as written; the parents are followed.
    refused(() => resolveEntryWithin(join(root, "escape", "secret.txt"), root));
  });

  test("ordinary entries and spelling escapes behave as for resolveWithin", () => {
    allowed(() => resolveEntryWithin(join(root, "inside", "a.txt"), root));
    refused(() => resolveEntryWithin(join(root, "..", "outside", "secret.txt"), root));
  });
});

describe("isWithinAny — a path that may come from more than one known place", () => {
  // The CasaOS migration reads a compose file the user can name. It may come from CasaOS's
  // app folder or from anywhere the file manager may go, and nowhere else.
  test("inside either root is allowed, outside both is refused", () => {
    const casaos = join(base, "outside");          // stands in for CasaOS's app folder
    expect(isWithinAny(join(root, "inside", "a.txt"), [casaos, root])).toBe(true);
    expect(isWithinAny(join(casaos, "secret.txt"), [casaos, root])).toBe(true);
    expect(isWithinAny("/etc/passwd", [casaos, root])).toBe(false);
  });

  test("a link out of one root does not count as being inside it", () => {
    const unrelated = mkdtempSync(join(tmpdir(), "anpan-guard-other-"));
    try {
      expect(isWithinAny(join(root, "escape", "secret.txt"), [root, unrelated])).toBe(false);
    } finally {
      rmSync(unrelated, { recursive: true, force: true });
    }
  });

  test("a files root of / admits anything, as the file manager does", () => {
    expect(isWithinAny("/etc/hostname", [join(base, "outside"), "/"])).toBe(true);
  });
});
