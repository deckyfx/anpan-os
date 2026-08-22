import { test, expect, describe } from "bun:test";
import { parseImageRef, checkability } from "../src/lib/image-ref";

/** A canonical 64-hex digest; the parser rejects anything shorter. */
const D = `sha256:${"a".repeat(64)}`;

describe("parseImageRef — Docker Hub shorthand", () => {
  test("bare name gets library/ and :latest", () => {
    expect(parseImageRef("nginx")).toMatchObject({
      registry: "registry-1.docker.io", repository: "library/nginx", tag: "latest",
    });
  });

  test("explicit tag is kept", () => {
    expect(parseImageRef("nginx:alpine")).toMatchObject({
      repository: "library/nginx", tag: "alpine",
    });
  });

  test("user image is not given the library namespace", () => {
    expect(parseImageRef("gotson/komga:latest")).toMatchObject({
      registry: "registry-1.docker.io", repository: "gotson/komga", tag: "latest",
    });
  });

  test("a user namespace is not mistaken for a registry host", () => {
    // "myuser" has no dot or colon, so it is a namespace, not a host.
    expect(parseImageRef("myuser/app")).toMatchObject({
      registry: "registry-1.docker.io", repository: "myuser/app",
    });
  });
});

describe("parseImageRef — other registries", () => {
  test("ghcr.io", () => {
    expect(parseImageRef("ghcr.io/thomiceli/opengist:latest")).toMatchObject({
      registry: "ghcr.io", repository: "thomiceli/opengist", tag: "latest",
    });
  });

  test("lscr.io", () => {
    expect(parseImageRef("lscr.io/linuxserver/chromium:latest")).toMatchObject({
      registry: "lscr.io", repository: "linuxserver/chromium",
    });
  });

  test("deep repository paths survive", () => {
    expect(parseImageRef("quay.io/a/b/c:v1")).toMatchObject({
      registry: "quay.io", repository: "a/b/c", tag: "v1",
    });
  });

  test("host:port is a registry, and its colon is not a tag", () => {
    expect(parseImageRef("localhost:5000/app:v2")).toMatchObject({
      registry: "localhost:5000", repository: "app", tag: "v2",
    });
  });

  test("host:port with no tag defaults to latest", () => {
    expect(parseImageRef("registry.internal:5000/team/app")).toMatchObject({
      registry: "registry.internal:5000", repository: "team/app", tag: "latest",
    });
  });
});

describe("parseImageRef — digests", () => {
  test("digest-pinned reference keeps the digest and has no tag", () => {
    const r = parseImageRef(`nginx@${D}`);
    expect(r).toMatchObject({ repository: "library/nginx", digest: D, tag: "" });
  });

  test("tag plus digest — the digest wins", () => {
    expect(parseImageRef(`nginx:alpine@${D}`)).toMatchObject({ tag: "alpine", digest: D });
  });

  test("a non-sha256 digest is rejected rather than guessed at", () => {
    expect(parseImageRef("nginx@md5:abc")).toBeNull();
  });

  test("a truncated digest is rejected — it must be 64 hex characters", () => {
    expect(parseImageRef("nginx@sha256:abc")).toBeNull();
    expect(parseImageRef(`nginx@sha256:${"a".repeat(63)}`)).toBeNull();
    expect(parseImageRef(`nginx@sha256:${"A".repeat(64)}`)).toBeNull();  // uppercase is not canonical
  });
});

describe("parseImageRef — rejects", () => {
  test.each(["", "   ", "@sha256:abc"])("%p is null", (input) => {
    expect(parseImageRef(input)).toBeNull();
  });

  test("names outside Docker's grammar are refused before they reach a URL", () => {
    // These would otherwise be interpolated into a registry path.
    expect(parseImageRef("../etc/passwd")).toBeNull();
    expect(parseImageRef("has space/app")).toBeNull();
    expect(parseImageRef("UPPER/case")).toBeNull();
    expect(parseImageRef("ghcr.io/a//b")).toBeNull();
  });

  test("a tag containing path characters is refused", () => {
    expect(parseImageRef("nginx:../../x")).toBeNull();
  });
});

describe("checkability", () => {
  test("an ordinary tagged image is checkable", () => {
    expect(checkability(parseImageRef("nginx:alpine")!)).toEqual({ checkable: true });
  });

  test("a digest-pinned image is skipped with a reason, not an error", () => {
    const r = checkability(parseImageRef(`nginx@${D}`)!);
    expect(r.checkable).toBe(false);
    expect(r.reason).toContain("digest");
  });
});
