import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app";
import { isProtectedRoot } from "../src/lib/bind-paths";
import { TEST_JWT, loginAs } from "./helpers";

/**
 * Deleting a folder had never worked: the route called `rm` without `recursive`, which fails
 * on every directory, and the client ignored the error. Now that it recurses — as root, with
 * the files root at "/" — the refusals carry the weight.
 *
 * The dangerous refusals (/, /etc, /usr …) are asserted on `isProtectedRoot` directly rather
 * than through the route, so a regression fails the test instead of deleting the directory.
 */

const app = createApp(TEST_JWT);
let cookie: string;
let root: string;

function del(path: string) {
  return app.handle(new Request("http://localhost/api/files/delete", {
    method:  "DELETE",
    body:    JSON.stringify({ path }),
    headers: { cookie, "content-type": "application/json" },
  }));
}

beforeAll(async () => {
  cookie = await loginAs();
  root = mkdtempSync(join(tmpdir(), "anpan-delete-"));
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("delete route", () => {
  test("a folder is removed with its contents", async () => {
    const dir = join(root, "full");
    mkdirSync(join(dir, "nested"), { recursive: true });
    await Bun.write(join(dir, "nested", "a.txt"), "a");

    expect((await del(dir)).status).toBe(200);
    expect(existsSync(dir)).toBe(false);
  });

  test("an empty folder is removed", async () => {
    const dir = join(root, "empty");
    mkdirSync(dir);
    expect((await del(dir)).status).toBe(200);
    expect(existsSync(dir)).toBe(false);
  });

  test("a file is removed", async () => {
    const file = join(root, "f.txt");
    await Bun.write(file, "x");
    expect((await del(file)).status).toBe(200);
    expect(existsSync(file)).toBe(false);
  });

  test("a symlink to a folder removes the link, not the target", async () => {
    const target = join(root, "target");
    mkdirSync(target);
    await Bun.write(join(target, "keep.txt"), "keep");
    const link = join(root, "link");
    symlinkSync(target, link);

    expect((await del(link)).status).toBe(200);
    expect(existsSync(link)).toBe(false);
    expect(await Bun.file(join(target, "keep.txt")).text()).toBe("keep");
  });

  test("a missing path is a 404", async () => {
    expect((await del(join(root, "nope"))).status).toBe(404);
  });

  test("a folder holding anpan-os's config is refused", async () => {
    // Point the config dir into the scratch tree, so a broken guard could only delete that.
    const parent = join(root, "host");
    const configDir = join(parent, "anpan-config");
    mkdirSync(configDir, { recursive: true });
    const previous = Bun.env.RUNTIME_CONFIG_DIR;
    Bun.env.RUNTIME_CONFIG_DIR = configDir;
    try {
      for (const path of [configDir, parent]) {
        const res = await del(path);
        expect(res.status).toBe(403);
      }
      expect(existsSync(configDir)).toBe(true);
    } finally {
      Bun.env.RUNTIME_CONFIG_DIR = previous;
    }
  });

  /** Run `fn` with the config dir pointed at `dir`, restoring it afterwards. */
  async function withConfigDir(dir: string, fn: () => Promise<void>) {
    const previous = Bun.env.RUNTIME_CONFIG_DIR;
    Bun.env.RUNTIME_CONFIG_DIR = dir;
    try { await fn(); } finally { Bun.env.RUNTIME_CONFIG_DIR = previous; }
  }

  test("the config dir is protected when RUNTIME_CONFIG_DIR is a symlink to it", async () => {
    // RUNTIME_CONFIG_DIR=/opt/anpan, a link to /DATA/AppData/anpan. Deleting the real
    // directory by its own name matched no spelling of the config path, and went ahead.
    const real = join(root, "sym-data", "AppData", "anpan");
    const link = join(root, "sym-opt-anpan");
    mkdirSync(real, { recursive: true });
    symlinkSync(real, link);

    await withConfigDir(link, async () => {
      for (const path of [real, join(root, "sym-data", "AppData"), join(root, "sym-data")]) {
        expect((await del(path)).status).toBe(403);
      }
    });
    expect(existsSync(real)).toBe(true);
  });

  test("the config dir is protected when reached through a symlinked parent", async () => {
    // macOS's shape: /var is a link into /private/var, so the same directory has two names
    // and the config dir may have been set using the other one.
    const realParent  = join(root, "private-var");
    const aliasParent = join(root, "var-alias");
    mkdirSync(join(realParent, "anpan"), { recursive: true });
    symlinkSync(realParent, aliasParent);

    await withConfigDir(join(aliasParent, "anpan"), async () => {
      for (const path of [join(realParent, "anpan"), realParent]) {
        expect((await del(path)).status).toBe(403);
      }
    });
    expect(existsSync(join(realParent, "anpan"))).toBe(true);
  });

  test("a symlink pointing at the config dir can still be deleted, removing only the link", async () => {
    // Canonicalising must stop at the parent: the link's own name is what rm removes, so
    // refusing it would be over-cautious and resolving it fully would be wrong.
    const real = join(root, "cfg-real");
    const link = join(root, "cfg-shortcut");
    mkdirSync(real, { recursive: true });
    symlinkSync(real, link);

    await withConfigDir(real, async () => {
      expect((await del(link)).status).toBe(200);
    });
    expect(existsSync(link)).toBe(false);
    expect(existsSync(real)).toBe(true);
  });
});

describe("isProtectedRoot", () => {
  test("system and shared roots are protected, including macOS's /private links", async () => {
    for (const p of ["/", "/etc", "/usr", "/var", "/tmp", "/home", "/DATA/AppData"]) {
      expect(await isProtectedRoot(p)).toBe(true);
    }
  });

  test("what lies below a root is not", async () => {
    for (const p of ["/usr/local/old-app", "/DATA/AppData/myapp", join(root, "x")]) {
      expect(await isProtectedRoot(p)).toBe(false);
    }
  });
});
