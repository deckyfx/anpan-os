/**
 * Backups: taking one, restoring from it, staging the system part, and importing an upload.
 *
 * Docker is faked; `tar` is the real one, so the archives these tests make and unpack are
 * real archives, and a restore is checked by the files it puts back.
 */
import { test, expect, describe, afterEach, afterAll, beforeEach, spyOn } from "bun:test";
import { isAbsolute, join, relative, resolve } from "node:path";
import { mkdir, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { chmodSync, existsSync, mkdirSync, realpathSync, renameSync, writeFileSync, readFileSync } from "node:fs";
import { JobManager, processRunner, type JobContext, type JobSummary } from "../src/lib/jobs";
import {
  backupIdFor, backupPath, getBackup, listBackups, parseManifest, prepareUploads, runBackup, runImport, runRestore, uploadPath,
  type BackupManifest,
} from "../src/lib/backups";
import { applyPendingRestore, PENDING_DIR, READY_MARKER } from "../src/lib/pending-restore";
import { stackDir } from "../src/lib/stack-ops";
import { reservePaths } from "../src/lib/path-reservations";
import { StackStore } from "../src/stores/stack-store";
import { DockerClient } from "../src/lib/docker";
import { config } from "../src/config";
import { envConfig } from "../src/env-config";
import { Database } from "bun:sqlite";

const APP = "bk-app";
const LIVE = "bk-live";
const appDir  = stackDir(APP);
const dataDir = join(config.appDataRoot, APP);

const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => { while (spies.length) spies.pop()!.mockRestore(); });

// Every folder these tests delete in must be inside the test runtime dir, never a real one.
const TEST_ROOT = resolve("configs/anpan-test");
for (const dir of [config.backupsFolder, config.composeFolder, config.appDataRoot, envConfig.RUNTIME_CONFIG_DIR]) {
  const rel = relative(TEST_ROOT, resolve(dir));
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`Refusing to run: ${dir} is not under ${TEST_ROOT}`);
}

async function clean(): Promise<void> {
  for (const name of [APP, LIVE]) {
    await rm(stackDir(name), { recursive: true, force: true });
    await rm(join(config.appDataRoot, name), { recursive: true, force: true });
    await StackStore.delete(name);
  }
  await rm(config.backupsFolder, { recursive: true, force: true });
  await rm(join(envConfig.RUNTIME_CONFIG_DIR, PENDING_DIR), { recursive: true, force: true });
  // Aside copies a failed test may have left.
  for (const parent of [config.composeFolder, config.appDataRoot]) {
    for (const entry of await readdir(parent).catch(() => [] as string[])) {
      if (entry.includes(".pre-restore-")) await rm(join(parent, entry), { recursive: true, force: true });
    }
  }
}
afterAll(clean);

/** Docker commands run, in order, as `compose <stack> <verb…>`; tar runs as `tar`. */
let ran: string[] = [];
/** Services `ps --status running` reports. */
let running: string[] = [];
/** Exit code per recorded command prefix. */
let exitCodes: Record<string, number> = {};
/** Bind sources of other apps' containers, as Docker reports them. */
let otherBinds: string[] = [];
/** Docker cannot be read. */
let dockerDown = false;
/** Exit codes for successive `up` runs, first one first; then `exitCodes` applies. */
let upResults: number[] = [];
/** The app's settings.json as each `up` found it. */
let seenAtUp: string[] = [];

function record(argv: string[]): string {
  if (argv[0]!.endsWith("tar")) return "tar";
  // docker compose -p <stack> -f <file> <verb…>
  return ["compose", argv[3], ...argv.slice(6)].join(" ");
}

function resolvedFor(cwd: string): unknown {
  return {
    services: {
      web: {
        volumes: [
          { type: "bind", source: join(dataDir, "config"), target: "/config" },
          { type: "bind", source: join(dataDir, "cache"), target: "/cache" },
          { type: "bind", source: "/DATA/Media", target: "/media" },
          { type: "bind", source: join(cwd, "local"), target: "/local" },
          { type: "volume", source: "dbdata", target: "/var/lib/db" },
        ],
      },
    },
  };
}

beforeEach(async () => {
  await clean();
  ran = [];
  running = ["web"];
  exitCodes = {};
  otherBinds = [];
  dockerDown = false;
  upResults = [];
  seenAtUp = [];
  spies.push(spyOn(DockerClient, "listContainers").mockImplementation(async () => dockerDown ? { ok: false as const, error: "no socket" } as never : ({
    ok: true as const,
    data: otherBinds.length === 0 ? [] : [{ Id: "other", Labels: { "com.docker.compose.project": "other-app" } }] as never,
  })));
  spies.push(spyOn(DockerClient, "inspectContainer").mockImplementation(async () => ({
    ok: true as const,
    data: { Mounts: otherBinds.map(Source => ({ Type: "bind", Source, Destination: "/x" })) } as never,
  })));
  spies.push(spyOn(processRunner, "capture").mockImplementation(async (argv, opts) => {
    const cmd = record(argv);
    ran.push(cmd);
    if (cmd.includes(" config ")) return { code: 0, stdout: JSON.stringify(resolvedFor(opts.cwd)), stderr: "" };
    if (cmd.includes(" ps ")) return { code: 0, stdout: running.join("\n"), stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  }));
  spies.push(spyOn(processRunner, "run").mockImplementation(async (argv, opts) => {
    const cmd = record(argv);
    ran.push(cmd);
    if (cmd === "tar") {
      const proc = Bun.spawn(argv, { cwd: opts.cwd, stdout: "pipe", stderr: "pipe" });
      return proc.exited;
    }
    if (cmd.startsWith(`compose ${APP} up`)) {
      seenAtUp.push(readFileSync(join(dataDir, "config", "settings.json"), "utf8"));
      if (upResults.length > 0) return upResults.shift()!;
    }
    return Object.entries(exitCodes).find(([prefix]) => cmd.startsWith(prefix))?.[1] ?? 0;
  }));

  // An app: compose file and .env in its stack folder, data under the data root.
  await mkdir(join(appDir, "local"), { recursive: true });
  await writeFile(join(appDir, "docker-compose.yml"), "services:\n  web:\n    image: nginx\n");
  await writeFile(join(appDir, ".env"), "PUID=1000\n");
  await writeFile(join(appDir, "local", "note.txt"), "stack-v1");
  await mkdir(join(dataDir, "config"), { recursive: true });
  await writeFile(join(dataDir, "config", "settings.json"), "data-v1");
  await StackStore.claim(APP, { title: "Backup App" });
});

const manager = new JobManager();

async function runJob(body: (ctx: JobContext) => Promise<unknown>): Promise<{ job: JobSummary; log: string[] }> {
  const started = manager.start({ kind: "backup", title: "test" }, async ctx => { await body(ctx); });
  if (!started.ok) throw new Error("not started");
  for (let i = 0; i < 2000; i++) {
    const got = manager.get(started.job.id)!;
    if (got.job.status !== "running") return { job: got.job, log: got.log };
    await Bun.sleep(5);
  }
  throw new Error("job did not finish");
}

/** Take a backup and return its id. */
async function backUp(req = { system: false, apps: [APP] }): Promise<string> {
  let id = "";
  const { job, log } = await runJob(async ctx => { id = await runBackup(ctx, req); });
  if (job.status !== "done") throw new Error(`backup failed: ${job.error}\n${log.join("\n")}`);
  return id;
}

describe("taking a backup", () => {
  test("archives the stack folder and the data folder, with the app stopped for the copy", async () => {
    const id = await backUp();
    const m = (await getBackup(id))!;
    expect(m.apps).toHaveLength(1);
    const app = m.apps[0]!;
    expect(app).toMatchObject({ name: APP, origin: "anpan", live: false, running: ["web"], stack: `apps/${APP}/stack.tar.gz` });
    // One data folder, the app's own under the data root: config and cache are both in it,
    // and cache does not exist so it adds nothing.
    expect(app.data).toEqual([{ dir: APP, archive: `apps/${APP}/data-0.tar.gz` }]);
    expect(app.row).toMatchObject({ title: "Backup App", managed: true });
    expect(existsSync(join(backupPath(id), app.stack))).toBe(true);
    expect(existsSync(join(backupPath(id), app.data[0]!.archive))).toBe(true);

    // Stopped before the first archive, started after the last, with only what was running.
    const stop  = ran.indexOf(`compose ${APP} stop`);
    const start = ran.indexOf(`compose ${APP} start web`);
    expect(stop).toBeGreaterThan(-1);
    expect(start).toBeGreaterThan(stop);
    expect(ran.slice(stop + 1, start)).toEqual(["tar", "tar"]);
  });

  test("names what it leaves out: binds outside the data root and named volumes", async () => {
    let log: string[] = [];
    ({ log } = await runJob(async ctx => { await runBackup(ctx, { system: false, apps: [APP] }); }));
    expect(log.some(l => l.includes("Not included: /DATA/Media"))).toBe(true);
    expect(log.some(l => l.includes('named volume "dbdata"'))).toBe(true);
    // The bind inside the stack folder is in the stack archive, so it is not reported.
    expect(log.some(l => l.includes(join(appDir, "local")))).toBe(false);
  });

  test("copies an app set to back up live without stopping it", async () => {
    await StackStore.updateMeta(APP, { backupLive: true });
    const id = await backUp();
    expect((await getBackup(id))!.apps[0]!.live).toBe(true);
    expect(ran.some(c => c.endsWith(" stop") || c.includes(" start"))).toBe(false);
  });

  test("leaves a stopped app stopped", async () => {
    running = [];
    const id = await backUp();
    expect((await getBackup(id))!.apps[0]!.running).toEqual([]);
    expect(ran.some(c => c.endsWith(" stop") || c.includes(" start"))).toBe(false);
  });

  test("starts the app again when its copy fails", async () => {
    await rm(join(dataDir, "config"), { recursive: true });
    spies.pop()!.mockRestore(); // the run stub: replace it with one whose tar fails
    spies.push(spyOn(processRunner, "run").mockImplementation(async argv => {
      const cmd = record(argv);
      ran.push(cmd);
      return cmd === "tar" ? 2 : 0;
    }));
    await mkdir(join(dataDir, "config"), { recursive: true });
    const { job } = await runJob(async ctx => { await runBackup(ctx, { system: false, apps: [APP] }); });
    expect(job.status).toBe("failed");
    expect(ran).toContain(`compose ${APP} start web`);
    // Nothing was backed up, so no backup was kept.
    expect(await listBackups()).toEqual([]);
  });

  test("starts the app again when stopping it fails half way", async () => {
    exitCodes = { [`compose ${APP} stop`]: 1 };
    const { job } = await runJob(async ctx => { await runBackup(ctx, { system: false, apps: [APP] }); });
    expect(job.status).toBe("failed");
    expect(ran).toContain(`compose ${APP} start web`);
  });

  test("takes only its own folders from a data folder another app uses too", async () => {
    otherBinds = [join(dataDir, "theirs")];
    await mkdir(join(dataDir, "theirs"), { recursive: true });
    await writeFile(join(dataDir, "theirs", "keep.txt"), "theirs-v1");
    const id = await backUp();
    // config exists; cache does not, so only config is taken.
    expect((await getBackup(id))!.apps[0]!.data).toEqual([{ dir: `${APP}/config`, archive: `apps/${APP}/data-0.tar.gz` }]);

    // Restoring this app leaves the other app's folder as it is now.
    await writeFile(join(dataDir, "theirs", "keep.txt"), "theirs-v2");
    await writeFile(join(dataDir, "config", "settings.json"), "data-v2");
    const { job } = await runJob(ctx => runRestore(ctx, { id, system: false, apps: [APP] }));
    expect(job.status).toBe("done");
    expect(readFileSync(join(dataDir, "config", "settings.json"), "utf8")).toBe("data-v1");
    expect(readFileSync(join(dataDir, "theirs", "keep.txt"), "utf8")).toBe("theirs-v2");
  });

  test("refuses to restore folders a deploy of another app holds", async () => {
    const id = await backUp();
    // With links followed, as every caller passes them.
    const held = reservePaths("other-app", "install", [realpathSync(join(dataDir, "config"))]);
    if (!held.ok) throw new Error("not reserved");
    try {
      ran = [];
      const { job, log } = await runJob(ctx => runRestore(ctx, { id, system: false, apps: [APP] }));
      expect(job.status).toBe("failed");
      expect(log.some(l => l.includes("other-app"))).toBe(true);
      expect(ran.some(c => c.endsWith(" stop"))).toBe(false);
    } finally {
      held.release();
    }
    // Released, the restore goes ahead, and gives its own hold back when done.
    expect((await runJob(ctx => runRestore(ctx, { id, system: false, apps: [APP] }))).job.status).toBe("done");
    const again = reservePaths("other-app", "install", [realpathSync(dataDir)]);
    expect(again.ok).toBe(true);
    if (again.ok) again.release();
  });

  test("refuses to restore over a folder another app has started using", async () => {
    const id = await backUp();
    otherBinds = [join(dataDir, "config")];
    await writeFile(join(dataDir, "config", "settings.json"), "data-v2");
    ran = [];
    const { job } = await runJob(ctx => runRestore(ctx, { id, system: false, apps: [APP] }));
    expect(job.status).toBe("failed");
    expect(job.error).toContain(APP);
    expect(readFileSync(join(dataDir, "config", "settings.json"), "utf8")).toBe("data-v2");
    expect(ran.some(c => c.endsWith(" stop"))).toBe(false);
  });

  test("fails rather than guess when Docker cannot say which folders other apps use", async () => {
    dockerDown = true;
    const { job } = await runJob(async ctx => { await runBackup(ctx, { system: false, apps: [APP] }); });
    expect(job.status).toBe("failed");
  });

  test("leaves the backups folder out of a folder that holds it", async () => {
    // A data folder that holds the backups folder: point [backups] folder inside it.
    const inside = join(dataDir, "config", "backups-here");
    // An own property shadows the class's getter; deleting it brings the getter back.
    Object.defineProperty(config, "backupsFolder", { get: () => resolve(inside), configurable: true });
    try {
      const id = await backUp();
      const list = Bun.spawnSync(["tar", "-tzf", join(resolve(inside), id, "apps", APP, "data-0.tar.gz")]).stdout.toString();
      expect(list).toContain("settings.json");
      expect(list).not.toContain("backups-here");

      // And it restores, though moving the data folder aside moves the backup with it.
      await writeFile(join(dataDir, "config", "settings.json"), "data-v2");
      const { job, log } = await runJob(ctx => runRestore(ctx, { id, system: false, apps: [APP] }));
      expect(job.status, log.join("\n")).toBe("done");
      expect(readFileSync(join(dataDir, "config", "settings.json"), "utf8")).toBe("data-v1");
    } finally {
      delete (config as { backupsFolder?: string }).backupsFolder;
    }
  });

  test("leaves out a data folder that is a link to outside the data root", async () => {
    const outside = join(envConfig.RUNTIME_CONFIG_DIR, "bk-outside");
    await rm(outside, { recursive: true, force: true });
    await mkdir(join(outside, "config"), { recursive: true });
    await rm(dataDir, { recursive: true });
    await symlink(resolve(outside), dataDir);
    try {
      let id = "";
      const { job, log } = await runJob(async ctx => { id = await runBackup(ctx, { system: false, apps: [APP] }); });
      expect(job.status).toBe("done");
      expect((await getBackup(id))!.apps[0]!.data).toEqual([]);
      expect(log.some(l => l.includes("a link to"))).toBe(true);
    } finally {
      await rm(dataDir, { force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("includes the system: settings and a snapshot of the database", async () => {
    const id = await backUp({ system: true, apps: [] });
    const m = (await getBackup(id))!;
    expect(m.system).toBe("system.tar.gz");
    const list = Bun.spawnSync(["tar", "-tzf", join(backupPath(id), "system.tar.gz")]).stdout.toString();
    expect(list.split("\n")).toContain("storage.db");
  });

  test("is listed once complete, newest first, with its size", async () => {
    const id = await backUp();
    const list = await listBackups();
    expect(list.map(b => b.id)).toEqual([id]);
    expect(list[0]!.size).toBeGreaterThan(0);
    expect(list[0]!.apps).toEqual([{ name: APP, live: false, wasRunning: true, dataDirs: [APP] }]);
    // No partial folder is left behind.
    expect((await readdir(config.backupsFolder)).filter(n => n.startsWith("."))).toEqual([]);
  });
});

describe("restoring", () => {
  test("puts the stack folder, the data and the row back, and starts the app", async () => {
    const id = await backUp();
    await writeFile(join(appDir, "local", "note.txt"), "stack-v2");
    await writeFile(join(dataDir, "config", "settings.json"), "data-v2");
    await writeFile(join(dataDir, "config", "added-later.txt"), "x");
    await StackStore.updateMeta(APP, { title: "Renamed" });
    ran = [];

    const { job, log } = await runJob(ctx => runRestore(ctx, { id, system: false, apps: [APP] }));
    expect(job.status, log.join("\n")).toBe("done");
    expect(readFileSync(join(appDir, "local", "note.txt"), "utf8")).toBe("stack-v1");
    expect(readFileSync(join(dataDir, "config", "settings.json"), "utf8")).toBe("data-v1");
    // Replaced, not merged: a file added since the backup is gone.
    expect(existsSync(join(dataDir, "config", "added-later.txt"))).toBe(false);
    expect((await StackStore.findById(APP))!.title).toBe("Backup App");
    // Stopped (not down: anonymous volumes stay attached), then what was running started.
    expect(ran.filter(c => c.startsWith("compose"))).toEqual([`compose ${APP} ps --status running --services`, `compose ${APP} stop`, `compose ${APP} up -d --no-deps web`]);
    // The safety copies are deleted once it worked.
    expect((await readdir(config.composeFolder)).some(n => n.includes(".pre-restore-"))).toBe(false);
    expect((await readdir(config.appDataRoot)).some(n => n.includes(".pre-restore-"))).toBe(false);
  });

  test("puts back what was there when the restore fails", async () => {
    const id = await backUp();
    await writeFile(join(dataDir, "config", "settings.json"), "data-v2");
    await StackStore.updateMeta(APP, { title: "Renamed" });
    // The restored app fails to start; starting it again on its own files works.
    upResults = [1, 0];
    ran = [];

    const { job, log } = await runJob(ctx => runRestore(ctx, { id, system: false, apps: [APP] }));
    expect(job.status).toBe("failed");
    expect(job.error).toContain(APP);
    // The first up saw the backup's files, the second the files put back.
    expect(seenAtUp).toEqual(["data-v1", "data-v2"]);
    expect(log.some(l => l.includes("Could not"))).toBe(false);
    expect(readFileSync(join(dataDir, "config", "settings.json"), "utf8")).toBe("data-v2");
    expect((await StackStore.findById(APP))!.title).toBe("Renamed");
    expect((await readdir(config.appDataRoot)).some(n => n.includes(".pre-restore-"))).toBe(false);
    // It was running before, so what was running is started again, on its own files.
    expect(ran.filter(c => c === `compose ${APP} up -d --no-deps web`)).toHaveLength(2);
    expect(ran).toContain(`compose ${APP} stop`);
  });

  test("restores an app that is no longer installed", async () => {
    const id = await backUp();
    await rm(appDir, { recursive: true });
    await rm(dataDir, { recursive: true });
    await StackStore.delete(APP);

    const { job } = await runJob(ctx => runRestore(ctx, { id, system: false, apps: [APP] }));
    expect(job.status).toBe("done");
    expect(readFileSync(join(dataDir, "config", "settings.json"), "utf8")).toBe("data-v1");
    expect((await StackStore.findById(APP))!.managed).toBe(true);
  });

  test("refuses an app whose data was under another data root", async () => {
    const id = await backUp();
    const path = join(backupPath(id), "manifest.json");
    const m = JSON.parse(readFileSync(path, "utf8")) as BackupManifest;
    writeFileSync(path, JSON.stringify({ ...m, dataRoot: "/somewhere/else" }));

    const { job } = await runJob(ctx => runRestore(ctx, { id, system: false, apps: [APP] }));
    expect(job.status).toBe("failed");
    expect(readFileSync(join(dataDir, "config", "settings.json"), "utf8")).toBe("data-v1");
  });

  test("stages the system part for the next start", async () => {
    const id = await backUp({ system: true, apps: [] });
    const { job } = await runJob(ctx => runRestore(ctx, { id, system: true, apps: [] }));
    expect(job.status).toBe("done");
    const staged = join(envConfig.RUNTIME_CONFIG_DIR, PENDING_DIR);
    expect(existsSync(join(staged, READY_MARKER))).toBe(true);
    expect(existsSync(join(staged, "storage.db"))).toBe(true);
  });
});

describe("staging checks", () => {
  test("refuses a system part with no database, and keeps a restore staged before", async () => {
    const id = await backUp({ system: true, apps: [] });
    // Stage a good one first.
    expect((await runJob(ctx => runRestore(ctx, { id, system: true, apps: [] }))).job.status).toBe("done");
    // Then replace the backup's system archive with one holding only config.toml.
    const work = join(envConfig.RUNTIME_CONFIG_DIR, "bk-sys");
    await rm(work, { recursive: true, force: true });
    await mkdir(work);
    await writeFile(join(work, "config.toml"), "x = 1\n");
    Bun.spawnSync(["tar", "-czf", join(backupPath(id), "system.tar.gz"), "-C", work, "config.toml"]);
    await rm(work, { recursive: true });

    const { job } = await runJob(ctx => runRestore(ctx, { id, system: true, apps: [] }));
    expect(job.status).toBe("failed");
    expect(job.error).toContain("no database");
    const staged = join(envConfig.RUNTIME_CONFIG_DIR, PENDING_DIR);
    expect(existsSync(join(staged, READY_MARKER))).toBe(true);
    expect(existsSync(join(staged, "storage.db"))).toBe(true);
  });

  test("stages only the system entries, refusing links among them", async () => {
    const id = await backUp({ system: true, apps: [] });
    const work = join(envConfig.RUNTIME_CONFIG_DIR, "bk-sys");
    await rm(work, { recursive: true, force: true });
    await mkdir(work);
    copyTestDatabase(join(work, "storage.db"));
    await symlink("/etc/hostname", join(work, ".ready"));
    await writeFile(join(work, "extra.txt"), "x");
    Bun.spawnSync(["tar", "-czf", join(backupPath(id), "system.tar.gz"), "-C", work, "storage.db", ".ready", "extra.txt"]);

    expect((await runJob(ctx => runRestore(ctx, { id, system: true, apps: [] }))).job.status).toBe("done");
    const staged = join(envConfig.RUNTIME_CONFIG_DIR, PENDING_DIR);
    expect(readFileSync(join(staged, READY_MARKER), "utf8")).toBe(`${id}\n`);
    expect(existsSync(join(staged, "extra.txt"))).toBe(false);

    // A link in place of the database is refused.
    await rm(join(work, "storage.db"));
    await symlink("/etc/hostname", join(work, "storage.db"));
    Bun.spawnSync(["tar", "-czf", join(backupPath(id), "system.tar.gz"), "-C", work, "storage.db"]);
    await rm(work, { recursive: true });
    const { job } = await runJob(ctx => runRestore(ctx, { id, system: true, apps: [] }));
    expect(job.status).toBe("failed");
    expect(job.error).toContain("unexpected storage.db");
  });

  test("refuses a database SQLite cannot use", async () => {
    const id = await backUp({ system: true, apps: [] });
    const work = join(envConfig.RUNTIME_CONFIG_DIR, "bk-sys");
    await rm(work, { recursive: true, force: true });
    await mkdir(work);
    await writeFile(join(work, "storage.db"), "not a database");
    Bun.spawnSync(["tar", "-czf", join(backupPath(id), "system.tar.gz"), "-C", work, "storage.db"]);
    await rm(work, { recursive: true });
    const { job } = await runJob(ctx => runRestore(ctx, { id, system: true, apps: [] }));
    expect(job.status).toBe("failed");
    expect(job.error).toContain("cannot be used");
    expect(existsSync(join(envConfig.RUNTIME_CONFIG_DIR, PENDING_DIR))).toBe(false);
  });

  test("refuses a database this build cannot start on", async () => {
    const id = await backUp({ system: true, apps: [] });
    const work = join(envConfig.RUNTIME_CONFIG_DIR, "bk-sys");
    await rm(work, { recursive: true, force: true });
    await mkdir(work);
    // From a newer build: one migration more than this one knows.
    copyTestDatabase(join(work, "storage.db"));
    const db = new Database(join(work, "storage.db"));
    db.run("INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('future', 99999999999999)");
    db.close();
    Bun.spawnSync(["tar", "-czf", join(backupPath(id), "system.tar.gz"), "-C", work, "storage.db"]);
    await rm(work, { recursive: true });
    const { job } = await runJob(ctx => runRestore(ctx, { id, system: true, apps: [] }));
    expect(job.status).toBe("failed");
    expect(job.error).toContain("this version of anpan-os");
    expect(existsSync(join(envConfig.RUNTIME_CONFIG_DIR, PENDING_DIR))).toBe(false);
  });

  test("refuses the system from a backup without one before touching any app", async () => {
    const id = await backUp();
    ran = [];
    const { job } = await runJob(ctx => runRestore(ctx, { id, system: true, apps: [APP] }));
    expect(job.status).toBe("failed");
    expect(ran).toEqual([]);
  });
});

describe("applying a staged system restore", () => {
  const dir = join(envConfig.RUNTIME_CONFIG_DIR, "pending-restore-test");
  beforeEach(() => {
    rmSyncSafe(dir);
    mkdirSync(join(dir, PENDING_DIR, "certs"), { recursive: true });
    mkdirSync(join(dir, "certs"), { recursive: true });
    writeFileSync(join(dir, "config.toml"), "old");
    writeFileSync(join(dir, "storage.db"), "old-db");
    writeFileSync(join(dir, "storage.db-wal"), "old-wal");
    writeFileSync(join(dir, "certs", "old.pem"), "old");
    writeFileSync(join(dir, PENDING_DIR, "config.toml"), "new");
    writeFileSync(join(dir, PENDING_DIR, "storage.db"), "new-db");
    writeFileSync(join(dir, PENDING_DIR, "certs", "new.pem"), "new");
  });
  afterAll(() => rmSyncSafe(dir));

  test("does nothing until the staging is marked ready", () => {
    expect(applyPendingRestore(dir)).toEqual([]);
    expect(readFileSync(join(dir, "config.toml"), "utf8")).toBe("old");
  });

  test("finishes a start that stopped part way", () => {
    writeFileSync(join(dir, PENDING_DIR, READY_MARKER), "x");
    // As left by a start that moved config.toml into .originals, put the new one in
    // place, and then stopped.
    mkdirSync(join(dir, PENDING_DIR, ".originals"));
    renameSync(join(dir, "config.toml"), join(dir, PENDING_DIR, ".originals", "config.toml"));
    renameSync(join(dir, PENDING_DIR, "config.toml"), join(dir, "config.toml"));
    expect(applyPendingRestore(dir)).toEqual(["storage.db", "certs"]);
    expect(readFileSync(join(dir, "config.toml"), "utf8")).toBe("new");
    expect(readFileSync(join(dir, "storage.db"), "utf8")).toBe("new-db");
    expect(existsSync(join(dir, PENDING_DIR))).toBe(false);
  });

  // Moving a folder to another parent needs write access to the folder itself on Linux;
  // a read-only staged certs/ is the last entry, and fails after the others went in.
  const canFailRename = process.platform === "linux" && process.getuid?.() !== 0;
  test.if(canFailRename)("puts everything back when an entry cannot go in, and keeps the staging", () => {
    writeFileSync(join(dir, PENDING_DIR, READY_MARKER), "x");
    chmodSync(join(dir, PENDING_DIR, "certs"), 0o555);
    try {
      expect(() => applyPendingRestore(dir)).toThrow();
    } finally {
      chmodSync(join(dir, PENDING_DIR, "certs"), 0o755);
    }
    // The entries that went in are back in the staging, and the originals in place.
    expect(readFileSync(join(dir, "config.toml"), "utf8")).toBe("old");
    expect(readFileSync(join(dir, "storage.db"), "utf8")).toBe("old-db");
    expect(readFileSync(join(dir, "storage.db-wal"), "utf8")).toBe("old-wal");
    expect(existsSync(join(dir, "certs", "old.pem"))).toBe(true);
    expect(readFileSync(join(dir, PENDING_DIR, "config.toml"), "utf8")).toBe("new");
    expect(existsSync(join(dir, PENDING_DIR, READY_MARKER))).toBe(true);
    // And the next start, with the cause fixed, applies it.
    expect(applyPendingRestore(dir)).toEqual(["config.toml", "storage.db", "certs"]);
    expect(readFileSync(join(dir, "config.toml"), "utf8")).toBe("new");
  });

  test.if(canFailRename)("keeps the old WAL with the old database when undoing a later start", () => {
    writeFileSync(join(dir, PENDING_DIR, READY_MARKER), "x");
    // An earlier start put storage.db in place (its original and WAL in .originals), then
    // stopped. This start fails on certs.
    mkdirSync(join(dir, PENDING_DIR, ".originals"));
    renameSync(join(dir, "storage.db"), join(dir, PENDING_DIR, ".originals", "storage.db"));
    renameSync(join(dir, "storage.db-wal"), join(dir, PENDING_DIR, ".originals", "storage.db-wal"));
    renameSync(join(dir, PENDING_DIR, "storage.db"), join(dir, "storage.db"));
    chmodSync(join(dir, PENDING_DIR, "certs"), 0o555);
    try {
      expect(() => applyPendingRestore(dir)).toThrow();
    } finally {
      chmodSync(join(dir, PENDING_DIR, "certs"), 0o755);
    }
    // The restored database stays; its old WAL does not come back beside it.
    expect(readFileSync(join(dir, "storage.db"), "utf8")).toBe("new-db");
    expect(existsSync(join(dir, "storage.db-wal"))).toBe(false);
    expect(existsSync(join(dir, PENDING_DIR, ".originals", "storage.db-wal"))).toBe(true);
  });

  test("a restore staged over another and cut short still applies the earlier one", () => {
    writeFileSync(join(dir, PENDING_DIR, READY_MARKER), "x");
    renameSync(join(dir, PENDING_DIR), join(dir, `${PENDING_DIR}.previous`));
    expect(applyPendingRestore(dir)).toEqual(["config.toml", "storage.db", "certs"]);
    expect(readFileSync(join(dir, "config.toml"), "utf8")).toBe("new");
    expect(existsSync(join(dir, `${PENDING_DIR}.previous`))).toBe(false);
  });

  test("replaces each entry, drops the old write-ahead log, and removes the staging", () => {
    writeFileSync(join(dir, PENDING_DIR, READY_MARKER), "x");
    expect(applyPendingRestore(dir)).toEqual(["config.toml", "storage.db", "certs"]);
    expect(readFileSync(join(dir, "config.toml"), "utf8")).toBe("new");
    expect(readFileSync(join(dir, "storage.db"), "utf8")).toBe("new-db");
    expect(existsSync(join(dir, "storage.db-wal"))).toBe(false);
    expect(existsSync(join(dir, "certs", "old.pem"))).toBe(false);
    expect(existsSync(join(dir, "certs", "new.pem"))).toBe(true);
    expect(existsSync(join(dir, PENDING_DIR))).toBe(false);
  });
});

/** A copy of the test database: a real one, with this build's migration history. */
function copyTestDatabase(to: string): void {
  const db = new Database(join(envConfig.RUNTIME_CONFIG_DIR, "storage.db"));
  try { db.run("VACUUM INTO ?", [to]); } finally { db.close(); }
}

function rmSyncSafe(path: string): void {
  Bun.spawnSync(["rm", "-rf", path]);
}

describe("importing an uploaded backup", () => {
  async function asUpload(id: string): Promise<string> {
    const uploadId = crypto.randomUUID();
    await prepareUploads();
    const r = Bun.spawnSync(["tar", "-cf", uploadPath(uploadId), "-C", config.backupsFolder, id]);
    if (r.exitCode !== 0) throw new Error(r.stderr.toString());
    return uploadId;
  }

  test("adds the backup under its own name, and removes the upload", async () => {
    const id = await backUp();
    const upload = await asUpload(id);
    await rm(backupPath(id), { recursive: true });

    const { job } = await runJob(async ctx => { await runImport(ctx, upload); });
    expect(job.status).toBe("done");
    expect((await listBackups()).map(b => b.id)).toEqual([id]);
    expect(existsSync(uploadPath(upload))).toBe(false);
  });

  test("takes a free name when the backup is already here", async () => {
    const id = await backUp();
    const upload = await asUpload(id);
    let added = "";
    const { job } = await runJob(async ctx => { added = await runImport(ctx, upload); });
    expect(job.status).toBe("done");
    expect(added).toBe(`${id}-2`);
    expect((await getBackup(added))!.id).toBe(added);
  });

  test("refuses a backup whose parts are links", async () => {
    const id = await backUp();
    const archive = join(backupPath(id), "apps", APP, "stack.tar.gz");
    await rm(archive);
    await symlink("/etc/hostname", archive);
    const upload = await asUpload(id);
    await rm(backupPath(id), { recursive: true });
    const { job } = await runJob(async ctx => { await runImport(ctx, upload); });
    expect(job.status).toBe("failed");
    expect(job.error).toContain("incomplete");
  });

  test("refuses an archive that is not a backup", async () => {
    const uploadId = crypto.randomUUID();
    await prepareUploads();
    Bun.spawnSync(["tar", "-cf", uploadPath(uploadId), "-C", appDir, "."]);
    const { job } = await runJob(async ctx => { await runImport(ctx, uploadId); });
    expect(job.status).toBe("failed");
    expect(job.error).toContain("not an anpan-os backup");
    expect(await listBackups()).toEqual([]);
    expect(existsSync(uploadPath(uploadId))).toBe(false);
  });
});

describe("manifest", () => {
  const good = (): Record<string, unknown> => ({
    format: 1, id: "20261128-093000", createdAt: "2026-11-28T09:30:00.000Z", version: "0.14.0",
    hostname: "ser8", dataRoot: "/DATA/AppData", system: "system.tar.gz",
    apps: [{
      name: "jellyfin", origin: "anpan", live: false, running: ["web"],
      stack: "apps/jellyfin/stack.tar.gz", data: [{ dir: "jellyfin", archive: "apps/jellyfin/data-0.tar.gz" }],
      row: { title: "Jellyfin" },
    }],
  });
  const withApp = (patch: Record<string, unknown>) => {
    const m = good();
    m.apps = [{ ...(m.apps as Record<string, unknown>[])[0], ...patch }];
    return JSON.stringify(m);
  };

  test("reads one this code wrote", () => {
    expect(parseManifest(JSON.stringify(good()))?.apps[0]?.name).toBe("jellyfin");
  });

  test("refuses archive names and data folders that leave their place", () => {
    expect(parseManifest(withApp({ stack: "../../etc/passwd" }))).toBeNull();
    expect(parseManifest(withApp({ stack: "apps/other/stack.tar.gz" }))).toBeNull();
    expect(parseManifest(withApp({ stack: "apps/jellyfin/data-0.tar.gz" }))).toBeNull();
    expect(parseManifest(withApp({ data: [{ dir: "jellyfin", archive: "apps/jellyfin/stack.tar.gz" }] }))).toBeNull();
    expect(parseManifest(withApp({ data: [{ dir: "..", archive: "apps/jellyfin/data-0.tar.gz" }] }))).toBeNull();
    expect(parseManifest(withApp({ data: [{ dir: "a/../b", archive: "apps/jellyfin/data-0.tar.gz" }] }))).toBeNull();
    expect(parseManifest(withApp({ data: [{ dir: "/etc", archive: "apps/jellyfin/data-0.tar.gz" }] }))).toBeNull();
    expect(parseManifest(withApp({ data: [{ dir: "a//b", archive: "apps/jellyfin/data-0.tar.gz" }] }))).toBeNull();
    expect(parseManifest(withApp({ running: ["../x"] }))).toBeNull();
    expect(parseManifest(withApp({ name: "../x" }))).toBeNull();
    expect(parseManifest(JSON.stringify({ ...good(), system: "/etc/shadow" }))).toBeNull();
    expect(parseManifest(JSON.stringify({ ...good(), id: "../x" }))).toBeNull();
  });

  test("takes a folder deeper down, but no folder in or at another", () => {
    expect(parseManifest(withApp({ data: [{ dir: "shared/jellyfin", archive: "apps/jellyfin/data-0.tar.gz" }] }))).not.toBeNull();
    for (const [a, b] of [["jellyfin", "jellyfin"], ["shared", "shared/jellyfin"], ["shared/jellyfin", "shared"]]) {
      expect(parseManifest(withApp({ data: [
        { dir: a, archive: "apps/jellyfin/data-0.tar.gz" },
        { dir: b, archive: "apps/jellyfin/data-1.tar.gz" },
      ] }))).toBeNull();
    }
  });

  test("refuses the same app twice", () => {
    const m = good();
    m.apps = [...(m.apps as unknown[]), ...(m.apps as unknown[])];
    expect(parseManifest(JSON.stringify(m))).toBeNull();
  });

  test("lists backups of one second in order, -10 after -9", async () => {
    for (const id of ["20261128-093000", "20261128-093000-2", "20261128-093000-9", "20261128-093000-10", "20261128-093001"]) {
      await mkdir(backupPath(id), { recursive: true });
      await writeFile(join(backupPath(id), "manifest.json"), JSON.stringify({ ...good(), id, system: null, apps: [] }));
    }
    expect((await listBackups()).map(b => b.id)).toEqual(
      ["20261128-093001", "20261128-093000-10", "20261128-093000-9", "20261128-093000-2", "20261128-093000"],
    );
  });

  test("names a backup by its UTC time", () => {
    expect(backupIdFor(new Date("2026-11-28T09:30:05.123Z"))).toBe("20261128-093005");
  });
});

