import { test, expect, describe, afterAll } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { binaryName } from "../src/lib/platform";
import {
  UpdateError, downloadVerified, fetchLatestRelease, installBinary, isNewer, withUpdateLock,
  type LatestRelease,
} from "../src/lib/self-update";

/**
 * The steps shared by the web updater and `anpan-os --upgrade`. Network calls go through an
 * injected fetch and the "installed binary" is a scratch file, so nothing here touches GitHub
 * or a real install.
 */

const root = mkdtempSync(join(tmpdir(), "anpan-selfupdate-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const sha256 = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

/** A fetch that answers from a table of URL → response factory. */
function fakeFetch(routes: Record<string, () => Response>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    const route = routes[url];
    return route ? route() : new Response("not found", { status: 404 });
  }) as typeof fetch;
}

describe("isNewer", () => {
  test("compares numerically, part by part, ignoring a leading v", () => {
    expect(isNewer("0.13.1", "0.13.0")).toBe(true);
    expect(isNewer("0.14.0", "0.13.9")).toBe(true);
    expect(isNewer("0.10.0", "0.9.0")).toBe(true);    // not as strings
    expect(isNewer("v1.0.0", "0.99.0")).toBe(true);
    expect(isNewer("0.13.0", "0.13.0")).toBe(false);
    expect(isNewer("0.12.9", "0.13.0")).toBe(false);
  });
});

describe("fetchLatestRelease", () => {
  const asset = binaryName();
  const api = "https://api.github.com/repos/deckyfx/anpan-os/releases/latest";

  test("picks this machine's asset and its checksum, and strips the v from the tag", async () => {
    const release = await fetchLatestRelease(fakeFetch({ [api]: () => Response.json({
      tag_name: "v9.9.9", body: "notes",
      assets: [
        { name: "anpan-os-some-other-platform", browser_download_url: "https://x/other" },
        { name: asset, browser_download_url: "https://x/bin" },
        { name: `${asset}.sha256`, browser_download_url: "https://x/sum" },
      ],
    }) }));
    expect(release).toEqual({ version: "9.9.9", notes: "notes", asset, binaryUrl: "https://x/bin", sha256Url: "https://x/sum" });
  });

  test("a GitHub error is an UpdateError the web route answers with 502", async () => {
    const err = await fetchLatestRelease(fakeFetch({ [api]: () => new Response("rate limited", { status: 403 }) })).catch(e => e);
    expect(err).toBeInstanceOf(UpdateError);
    expect(err.status).toBe(502);
  });
});

describe("downloadVerified", () => {
  const bytes = new TextEncoder().encode("pretend this is a 90 MB binary");
  const release: LatestRelease = { version: "9.9.9", notes: "", asset: "a", binaryUrl: "https://x/bin", sha256Url: "https://x/sum" };
  const serve = (sum: string) => fakeFetch({
    "https://x/sum": () => new Response(`${sum}  a\n`),
    "https://x/bin": () => new Response(bytes, { headers: { "content-length": String(bytes.byteLength) } }),
  });

  test("returns the bytes when they match the published checksum, reporting progress", async () => {
    const seen: [number, number | null][] = [];
    const got = await downloadVerified(release, (r, t) => seen.push([r, t]), serve(sha256(bytes)));
    expect(Buffer.from(got).equals(Buffer.from(bytes))).toBe(true);
    expect(seen.at(-1)).toEqual([bytes.byteLength, bytes.byteLength]);
  });

  test("a checksum mismatch is refused before anything is installed", async () => {
    const err = await downloadVerified(release, undefined, serve("0".repeat(64))).catch(e => e);
    expect(err).toBeInstanceOf(UpdateError);
    expect(err.status).toBe(422);
  });

  test("a release with no asset for this machine is refused", async () => {
    const err = await downloadVerified({ ...release, binaryUrl: "" }, undefined, serve(sha256(bytes))).catch(e => e);
    expect(err.status).toBe(404);
  });
});

describe("network failures", () => {
  const release: LatestRelease = { version: "9.9.9", notes: "", asset: "a", binaryUrl: "https://x/bin", sha256Url: "https://x/sum" };
  const unreachable = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;

  test("an unreachable GitHub is an UpdateError with 502, not a crash", async () => {
    // Escaping as a bare TypeError, it was answered as a server error and printed raw.
    for (const attempt of [fetchLatestRelease(unreachable), downloadVerified(release, undefined, unreachable)]) {
      const err = await attempt.catch(e => e);
      expect(err).toBeInstanceOf(UpdateError);
      expect(err.status).toBe(502);
      expect(err.message).toContain("Could not reach GitHub");
    }
  });

  test("an unreadable release description or checksum body is an UpdateError with 502", async () => {
    const api = "https://api.github.com/repos/deckyfx/anpan-os/releases/latest";
    // A proxy's HTML error page where JSON was expected.
    const err1 = await fetchLatestRelease(fakeFetch({ [api]: () => new Response("<html>bad gateway</html>") })).catch(e => e);
    expect(err1).toBeInstanceOf(UpdateError);
    expect(err1.status).toBe(502);

    // The checksum body failing while it is read.
    const failing = new ReadableStream<Uint8Array>({ pull(c) { c.error(new Error("connection reset")); } });
    const err2 = await downloadVerified(release, undefined, fakeFetch({
      "https://x/sum": () => new Response(failing),
      "https://x/bin": () => new Response("x"),
    })).catch(e => e);
    expect(err2).toBeInstanceOf(UpdateError);
    expect(err2.status).toBe(502);
  });

  test("a download that drops part-way is an UpdateError with 502", async () => {
    let sent = false;
    const dropping = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) { sent = true; controller.enqueue(new Uint8Array(1024)); return; }
        controller.error(new Error("connection reset"));
      },
    });
    const fetchImpl = fakeFetch({
      "https://x/sum": () => new Response(`${"0".repeat(64)}  a`),
      "https://x/bin": () => new Response(dropping),
    });
    const err = await downloadVerified(release, undefined, fetchImpl).catch(e => e);
    expect(err).toBeInstanceOf(UpdateError);
    expect(err.status).toBe(502);
    expect(err.message).toContain("interrupted");
  });
});

describe("installBinary", () => {
  test("replaces the target, executable, leaving nothing staged beside it", async () => {
    const dir = mkdtempSync(join(root, "install-"));
    const target = join(dir, "anpan-os");
    await Bun.write(target, "old");
    await installBinary(new TextEncoder().encode("new"), target);
    expect(await Bun.file(target).text()).toBe("new");
    expect(statSync(target).mode & 0o777).toBe(0o755);
    expect(readdirSync(dir)).toEqual(["anpan-os"]);
  });

  test("a failed replace leaves no staged copy behind", async () => {
    const dir = mkdtempSync(join(root, "install-fail-"));
    // The target is a directory, so the rename over it fails after the staged write.
    const target = join(dir, "anpan-os");
    Bun.spawnSync(["mkdir", "-p", join(target, "inside")]);
    const err = await installBinary(new TextEncoder().encode("new"), target).catch(e => e);
    expect(err).toBeInstanceOf(UpdateError);
    expect(readdirSync(dir)).toEqual(["anpan-os"]);
  });
});

describe("withUpdateLock", () => {
  test("a second update while one runs is refused with 409, and the lock is gone afterwards", async () => {
    const dir = mkdtempSync(join(root, "lock-"));
    const target = join(dir, "anpan-os");
    let release!: () => void;
    const first = withUpdateLock(() => new Promise<void>(r => { release = r; }), target);
    await Bun.sleep(20);
    const err = await withUpdateLock(async () => {}, target).catch(e => e);
    expect(err).toBeInstanceOf(UpdateError);
    expect(err.status).toBe(409);
    release();
    await first;
    expect(readdirSync(dir)).toEqual([]);
  });
});
