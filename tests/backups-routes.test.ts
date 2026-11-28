/**
 * The HTTP side of backups: what the routes refuse, and a download taken back by upload.
 * Docker is not reached: these backups are written by hand, and tar is the real one.
 */
import { test, expect, describe, beforeAll, beforeEach, afterEach, afterAll, spyOn } from "bun:test";
import { isAbsolute, join, relative, resolve } from "node:path";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createApp } from "../src/app";
import { TEST_JWT, loginAs } from "./helpers";
import { jobs, processRunner, type JobSummary } from "../src/lib/jobs";
import { config } from "../src/config";
import { uploadPath } from "../src/lib/backups";

const app = createApp(TEST_JWT);
let cookie = "";
beforeAll(async () => { cookie = await loginAs(); });

// The folder these tests delete must be inside the test runtime dir, never a real one.
const fromTestRoot = relative(resolve("configs/anpan-test"), config.backupsFolder);
if (fromTestRoot.startsWith("..") || isAbsolute(fromTestRoot)) throw new Error(`Refusing to run: ${config.backupsFolder}`);

const ID = "20261128-093000";
const MANIFEST = {
  format: 1, id: ID, createdAt: "2026-11-28T09:30:00.000Z", version: "test", hostname: "test",
  dataRoot: config.appDataRoot, system: null,
  apps: [{ name: "bk-route", origin: "anpan", live: false, running: [], stack: "apps/bk-route/stack.tar.gz", data: [], row: null }],
};

const spies: Array<{ mockRestore: () => void }> = [];
beforeEach(async () => {
  await rm(config.backupsFolder, { recursive: true, force: true });
  await mkdir(join(config.backupsFolder, ID, "apps", "bk-route"), { recursive: true });
  await writeFile(join(config.backupsFolder, ID, "manifest.json"), JSON.stringify(MANIFEST));
  await writeFile(join(config.backupsFolder, ID, "apps", "bk-route", "stack.tar.gz"), "not really an archive");
  spies.push(spyOn(processRunner, "run").mockImplementation(async (argv, opts) => {
    if (!argv[0]!.endsWith("tar")) throw new Error(`unexpected ${argv.join(" ")}`);
    return Bun.spawn(argv, { cwd: opts.cwd, stdout: "ignore", stderr: "ignore" }).exited;
  }));
});
afterEach(() => { while (spies.length) spies.pop()!.mockRestore(); });
afterAll(async () => { await rm(config.backupsFolder, { recursive: true, force: true }); });

async function call(method: string, path: string, body?: unknown, auth = true) {
  const res = await app.handle(new Request(`http://localhost${path}`, {
    method,
    headers: { ...(auth ? { cookie } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  return { status: res.status, body: await res.json().catch(() => null) as Record<string, unknown> | null };
}

async function finished(id: string): Promise<JobSummary> {
  for (let i = 0; i < 1000; i++) {
    const job = jobs.get(id)!.job;
    if (job.status !== "running") return job;
    await Bun.sleep(5);
  }
  throw new Error("job did not finish");
}

describe("refusals", () => {
  test("needs a session", async () => {
    expect((await call("GET", "/api/backups", undefined, false)).status).toBe(401);
  });

  test("a backup of nothing, or of an app with no compose file", async () => {
    expect((await call("POST", "/api/backups", { system: false, apps: [] })).status).toBe(422);
    const missing = await call("POST", "/api/backups", { system: false, apps: ["no-such-app"] });
    expect(missing.status).toBe(422);
    expect(missing.body?.error).toContain("no-such-app");
    expect((await call("POST", "/api/backups", { system: false, apps: ["../etc"] })).status).toBe(422);
  });

  test("a restore from a backup that is not there, or of what it does not hold", async () => {
    expect((await call("POST", "/api/backups/20200101-000000/restore", { system: false, apps: ["bk-route"] })).status).toBe(404);
    expect((await call("POST", `/api/backups/${ID}/restore`, { system: true, apps: [] })).status).toBe(422);
    expect((await call("POST", `/api/backups/${ID}/restore`, { system: false, apps: ["other"] })).status).toBe(422);
  });

  test("ids that are not backup names", async () => {
    expect((await call("GET", "/api/backups/..%2F..%2Fetc")).status).toBe(404);
    expect((await call("DELETE", "/api/backups/not-an-id")).status).toBe(404);
    expect((await call("POST", "/api/backups/import", { upload: "../x" })).status).toBe(400);
  });
});

describe("list, download, delete and upload", () => {
  test("a download that tar cannot finish fails instead of ending cleanly", async () => {
    // A part tar cannot read.
    const part = join(config.backupsFolder, ID, "apps", "bk-route", "stack.tar.gz");
    Bun.spawnSync(["chmod", "000", part]);
    try {
      if (process.getuid?.() === 0) return; // root reads it anyway
      const res = await app.handle(new Request(`http://localhost/api/backups/${ID}/download`, { headers: { cookie } }));
      expect(res.status).toBe(200);
      await expect(res.arrayBuffer()).rejects.toThrow();
    } finally {
      Bun.spawnSync(["chmod", "644", part]);
    }
  });

  test("a backup cannot be deleted while it is downloaded", async () => {
    const res = await app.handle(new Request(`http://localhost/api/backups/${ID}/download`, { headers: { cookie } }));
    expect((await call("DELETE", `/api/backups/${ID}`)).status).toBe(409);
    await res.arrayBuffer();
    expect((await call("DELETE", `/api/backups/${ID}`)).status).toBe(200);
  });

  test("abandoning an upload removes it, finished or not", async () => {
    const upload = crypto.randomUUID();
    const bytes = new TextEncoder().encode("abc");
    await app.handle(new Request(
      `http://localhost/api/backups/upload?id=${upload}&offset=0&total=${bytes.byteLength}`,
      { method: "PUT", headers: { cookie, "content-length": String(bytes.byteLength) }, body: bytes },
    ));
    expect(await Bun.file(uploadPath(upload)).exists()).toBe(true);
    expect((await call("DELETE", `/api/backups/upload?id=${upload}`)).status).toBe(200);
    expect(await Bun.file(uploadPath(upload)).exists()).toBe(false);
  });

  test("lists the backup", async () => {
    const { body } = await call("GET", "/api/backups");
    expect((body?.backups as { id: string }[]).map(b => b.id)).toEqual([ID]);
    expect(body?.restorePending).toBe(false);
  });

  test("a download is a tar of the backup folder, which upload and import take back", async () => {
    const res = await app.handle(new Request(`http://localhost/api/backups/${ID}/download`, { headers: { cookie } }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain(`anpan-backup-${ID}.tar`);
    const bytes = new Uint8Array(await res.arrayBuffer());

    expect((await call("DELETE", `/api/backups/${ID}`)).status).toBe(200);
    expect((await call("GET", `/api/backups/${ID}`)).status).toBe(404);

    const upload = crypto.randomUUID();
    const put = await app.handle(new Request(
      `http://localhost/api/backups/upload?id=${upload}&offset=0&total=${bytes.byteLength}`,
      { method: "PUT", headers: { cookie, "content-length": String(bytes.byteLength) }, body: bytes },
    ));
    expect(await put.json()).toMatchObject({ ok: true, done: true, received: bytes.byteLength });

    const started = await call("POST", "/api/backups/import", { upload });
    expect(started.status).toBe(202);
    const job = await finished((started.body!.job as JobSummary).id);
    expect(job.status, job.error ?? "").toBe("done");
    const { body } = await call("GET", "/api/backups");
    expect((body?.backups as { id: string }[]).map(b => b.id)).toEqual([ID]);
  });
});
