import { test, expect, describe } from "bun:test";
import { loadDockerCredentials } from "../src/lib/docker-credentials";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function configWith(body: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "anpan-creds-"));
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify(body));
  return path;
}

describe("loadDockerCredentials", () => {
  test("missing file yields no credentials rather than throwing", async () => {
    const creds = await loadDockerCredentials("/nonexistent/config.json");
    expect(creds.for("ghcr.io")).toBeNull();
    expect(creds.helperOnly).toEqual([]);
  });

  test("malformed JSON is tolerated", async () => {
    const dir = mkdtempSync(join(tmpdir(), "anpan-creds-"));
    const path = join(dir, "config.json");
    writeFileSync(path, "{not json");
    expect((await loadDockerCredentials(path)).for("ghcr.io")).toBeNull();
  });

  test("base64 auth is decoded", async () => {
    const auth = Buffer.from("alice:s3cret").toString("base64");
    const creds = await loadDockerCredentials(configWith({ auths: { "ghcr.io": { auth } } }));
    expect(creds.for("ghcr.io")).toEqual({ username: "alice", password: "s3cret" });
  });

  test("a password containing a colon survives the split", async () => {
    const auth = Buffer.from("alice:pa:ss:word").toString("base64");
    const creds = await loadDockerCredentials(configWith({ auths: { "ghcr.io": { auth } } }));
    expect(creds.for("ghcr.io")?.password).toBe("pa:ss:word");
  });

  test("Docker Hub's several spellings all resolve to the same registry", async () => {
    const auth = Buffer.from("bob:hunter2").toString("base64");
    const creds = await loadDockerCredentials(configWith({
      auths: { "https://index.docker.io/v1/": { auth } },
    }));
    // parseImageRef normalises bare images to registry-1.docker.io, so the lookup must
    // agree or Hub credentials would silently never be used.
    expect(creds.for("registry-1.docker.io")).toEqual({ username: "bob", password: "hunter2" });
    expect(creds.for("docker.io")).toEqual({ username: "bob", password: "hunter2" });
  });

  test("explicit username/password fields are honoured", async () => {
    const creds = await loadDockerCredentials(configWith({
      auths: { "reg.internal:5000": { username: "u", password: "p" } },
    }));
    expect(creds.for("reg.internal:5000")).toEqual({ username: "u", password: "p" });
  });

  test("registries behind a credential helper are reported, not silently skipped", async () => {
    const creds = await loadDockerCredentials(configWith({
      auths: {}, credHelpers: { "private.example.com": "osxkeychain" },
    }));
    expect(creds.for("private.example.com")).toBeNull();
    expect(creds.helperOnly).toContain("private.example.com");
  });

  test("an unknown registry has no credentials", async () => {
    const auth = Buffer.from("a:b").toString("base64");
    const creds = await loadDockerCredentials(configWith({ auths: { "ghcr.io": { auth } } }));
    expect(creds.for("quay.io")).toBeNull();
  });
});
