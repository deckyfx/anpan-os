/**
 * Install, redeploy, update-all and migrate as jobs, with Docker replaced by fakes.
 *
 * The order is the point of most of these. Everything an install needs (compose file,
 * .env, the stack's row) must exist before `docker compose up`, and a check that fails must
 * leave things as they were.
 */
import { test, expect, describe, afterEach, afterAll, beforeEach, spyOn } from "bun:test";
import { join } from "node:path";
import { rm, stat, readdir } from "node:fs/promises";
import { JobManager, processRunner, type JobContext, type JobSummary } from "../src/lib/jobs";
import { runDeploy, checkInstall, checkRedeploy, runUpdateAll, runMigrate, runRepair, stackDir, ownerFor, type DeployRequest } from "../src/lib/stack-ops";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import * as composeSource from "../src/lib/compose-source";
import { StackStore } from "../src/stores/stack-store";
import { DockerClient } from "../src/lib/docker";
import { ports as portProvider } from "../src/lib/providers/ports";
import { config } from "../src/config";

const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => { while (spies.length) spies.pop()!.mockRestore(); });

// The stack folders these tests write live in the test runtime directory, which persists.
afterAll(async () => {
  for (const name of ["ops-install", "ops-redeploy", "ops-u1", "ops-u2", "ops-migrate"]) {
    await rm(stackDir(name), { recursive: true, force: true });
    await StackStore.delete(name);
  }
  await rm(join(config.appDataRoot, "ops-install"), { recursive: true, force: true });
});

/** Commands the job ran, in order. */
let ran: string[] = [];
/** What `docker compose config` answers. */
let resolved: unknown = { services: {} };
/** Runs at `docker compose up`, to inspect the state at that moment. */
let onUp: (cwd: string) => Promise<void> | void = () => {};
/** Exit code per command prefix, e.g. { "compose pull": 1 }. */
let exitCodes: Record<string, number> = {};

beforeEach(() => {
  ran = [];
  resolved = { services: { web: { image: "nginx" } } };
  onUp = () => {};
  exitCodes = {};
  spies.push(spyOn(processRunner, "capture").mockImplementation(async argv => {
    ran.push(argv.slice(1).join(" "));
    return { code: 0, stdout: JSON.stringify(resolved), stderr: "" };
  }));
  spies.push(spyOn(processRunner, "run").mockImplementation(async (argv, opts) => {
    const cmd = argv.slice(1).join(" ");
    ran.push(cmd);
    if (/^compose -p \S+ up/.test(cmd)) await onUp(opts.cwd);
    const code = Object.entries(exitCodes).find(([prefix]) => cmd.startsWith(prefix))?.[1] ?? 0;
    return code;
  }));
  spies.push(spyOn(DockerClient, "hasComposeDrift").mockResolvedValue(false));
  spies.push(spyOn(DockerClient, "listProjectContainers").mockResolvedValue({ ok: true, data: [] }));
  spies.push(spyOn(DockerClient, "listContainers").mockResolvedValue({ ok: true, data: [] }));
  spies.push(spyOn(portProvider, "listeners").mockResolvedValue([]));
});

const manager = new JobManager();

async function runJob(body: (ctx: JobContext) => Promise<void>): Promise<{ job: JobSummary; log: string[] }> {
  const started = manager.start({ kind: "install", title: "test" }, body);
  if (!started.ok) throw new Error("not started");
  for (let i = 0; i < 400; i++) {
    const got = manager.get(started.job.id)!;
    if (got.job.status !== "running") return { job: got.job, log: got.log };
    await Bun.sleep(5);
  }
  throw new Error("job did not finish");
}

const exists = (p: string) => stat(p).then(() => true, () => false);
const COMPOSE = "services:\n  web:\n    image: nginx\n    environment:\n      TZ: $TZ\n    ports:\n      - 8080:80\n";

describe("install", () => {
  const name = "ops-install";
  beforeEach(async () => { await rm(stackDir(name), { recursive: true, force: true }); await StackStore.delete(name); });

  test("writes the compose file, .env and the managed row before docker compose up", async () => {
    let atUp: { compose: boolean; env: string; managed: boolean | undefined; title: string | null | undefined } | null = null;
    onUp = async cwd => {
      const row = await StackStore.findById(name);
      atUp = {
        compose: await exists(join(cwd, "docker-compose.yml")),
        env: await Bun.file(join(cwd, ".env")).text(),
        managed: row?.managed,
        title: row?.title,
      };
    };
    const req: DeployRequest = { name, compose: COMPOSE, env: "A=1\n", meta: { title: "Ops", icon: undefined } };
    const { job } = await runJob(ctx => runDeploy(ctx, "install", req));

    expect(job.status).toBe("done");
    expect(atUp).not.toBeNull();
    expect(atUp!.compose).toBe(true);
    expect(atUp!.managed).toBe(true);
    expect(atUp!.title).toBe("Ops");
    expect(atUp!.env).toStartWith("A=1\n");
    expect(atUp!.env).toContain(`TZ=${config.appTimeZone}`);   // the file uses $TZ
    expect(ran).toEqual([`compose -p ${name} config --format json`, `compose -p ${name} up -d`]);
  });

  test("a port conflict stops before up and removes what the install wrote", async () => {
    resolved = { services: { web: { ports: [{ target: 80, published: "8080" }] } } };
    spies.push(spyOn(portProvider, "listeners").mockResolvedValue([{ port: 8080, proto: "tcp", address: "0.0.0.0", process: "caddy", pid: 7 }]));
    const { job } = await runJob(ctx => runDeploy(ctx, "install", { name, compose: COMPOSE }));

    expect(job.status).toBe("failed");
    expect(job.error).toBe("Port conflict: port 8080/tcp (service web) is already used by process caddy (pid 7)");
    expect(ran.some(c => c.includes(" up"))).toBe(false);
    expect(await exists(stackDir(name))).toBe(false);
    expect(await StackStore.findById(name)).toBeNull();
  });

  test("a failed docker compose up removes the install, so it can simply be tried again", async () => {
    exitCodes = { [`compose -p ${name} up`]: 18 };
    const { job, log } = await runJob(ctx => runDeploy(ctx, "install", { name, compose: COMPOSE, meta: { title: "Ops" } }));
    expect(job.status).toBe("failed");
    expect(job.error).toBe("docker compose up failed (exit code 18)");
    expect(ran).toContain(`compose -p ${name} down --remove-orphans`);
    expect(log).toContain("Install failed: removing what it created");
    expect(await exists(stackDir(name))).toBe(false);
    expect(await StackStore.findById(name)).toBeNull();
    expect(await checkInstall({ name, compose: COMPOSE })).toBeNull();
  });

  test("a failure before docker compose up undoes the install without running down", async () => {
    spies.push(spyOn(StackStore, "claim").mockRejectedValue(new Error("database is locked")));
    const { job } = await runJob(ctx => runDeploy(ctx, "install", { name, compose: COMPOSE }));
    expect(job.error).toBe("database is locked");
    expect(ran.some(c => c.includes(" down"))).toBe(false);
    expect(await exists(stackDir(name))).toBe(false);
  });

  test("when docker compose down fails too, the files and row stay for a later clean-up", async () => {
    exitCodes = { [`compose -p ${name} up`]: 18, [`compose -p ${name} down`]: 1 };
    const { job, log } = await runJob(ctx => runDeploy(ctx, "install", { name, compose: COMPOSE }));
    expect(job.status).toBe("failed");
    expect(log.some(l => l.startsWith("Could not remove the stack's containers"))).toBe(true);
    expect(await exists(join(stackDir(name), "docker-compose.yml"))).toBe(true);
    expect((await StackStore.findById(name))?.managed).toBe(true);
  });

  test("checks again inside the job: a folder that appeared since the route checked is left untouched", async () => {
    await mkdir(stackDir(name), { recursive: true });
    await writeFile(join(stackDir(name), "notes.txt"), "mine");
    const { job } = await runJob(ctx => runDeploy(ctx, "install", { name, compose: COMPOSE }));
    expect(job.status).toBe("failed");
    expect(job.error).toContain("already exists");
    expect(await readdir(stackDir(name))).toEqual(["notes.txt"]);
  });

  test("creates missing bind folders under the data root, and only there", async () => {
    const inside = join(config.appDataRoot, name, "config");
    const outside = join(config.appDataRoot, "..", "elsewhere-ops");
    await rm(join(config.appDataRoot, name), { recursive: true, force: true });
    resolved = { services: { web: { volumes: [
      { type: "bind", source: inside, target: "/config" },
      { type: "bind", source: outside, target: "/x" },
      { type: "bind", source: join(config.appDataRoot, name, "app.conf"), target: "/app.conf" },
      { type: "volume", source: "named", target: "/data" },
    ] } } };
    const { job, log } = await runJob(ctx => runDeploy(ctx, "install", { name, compose: COMPOSE }));
    expect(job.status).toBe("done");
    expect(await exists(inside)).toBe(true);
    expect(await exists(outside)).toBe(false);
    expect(await exists(join(config.appDataRoot, name, "app.conf"))).toBe(false);   // a file mount is left alone
    expect(log.some(l => l.startsWith(`Created ${inside}`))).toBe(true);
  });

  test("bind folders: create_host_path false and a symlink out of the data root are left alone", async () => {
    const outside = join(config.appDataRoot, "..", "outside-ops");
    await rm(outside, { recursive: true, force: true });
    await mkdir(outside, { recursive: true });
    await rm(join(config.appDataRoot, name), { recursive: true, force: true });
    await mkdir(config.appDataRoot, { recursive: true });
    await symlink(outside, join(config.appDataRoot, name));
    const noCreate = join(config.appDataRoot, "ops-nocreate", "x");
    await rm(join(config.appDataRoot, "ops-nocreate"), { recursive: true, force: true });
    resolved = { services: { web: { volumes: [
      { type: "bind", source: join(config.appDataRoot, name, "config"), target: "/config" },
      { type: "bind", source: noCreate, target: "/x", bind: { create_host_path: false } },
    ] } } };
    const { job, log } = await runJob(ctx => runDeploy(ctx, "install", { name, compose: COMPOSE }));
    expect(job.status).toBe("done");
    expect(await exists(join(outside, "config"))).toBe(false);
    expect(await exists(noCreate)).toBe(false);
    expect(log.some(l => l.startsWith("Skipped") && l.includes("symlink"))).toBe(true);
    await rm(join(config.appDataRoot, name), { force: true });
    await rm(outside, { recursive: true, force: true });
  });

  test("folders are owned by the PUID and PGID in the stack's .env, else the configured ones", () => {
    expect(ownerFor("PUID=2001\nPGID: 2002\n")).toEqual({ puid: 2001, pgid: 2002 });
    expect(ownerFor("PUID=abc\n")).toEqual(config.appIds);
  });

  test("checkInstall refuses a name that is taken, and a file with no services", async () => {
    expect(await checkInstall({ name, compose: "services: {}\n" })).toEqual({ status: 422, error: "The compose file defines no services" });
    expect((await checkInstall({ name, compose: "services: [" }))?.status).toBe(422);

    spies.push(spyOn(DockerClient, "listProjectContainers").mockResolvedValue({ ok: true, data: [{ Labels: {} }] } as never));
    expect((await checkInstall({ name, compose: COMPOSE }))?.status).toBe(409);
    while (spies.length) spies.pop()!.mockRestore();

    await Bun.write(join(stackDir(name), "docker-compose.yml"), COMPOSE);
    spies.push(spyOn(DockerClient, "listProjectContainers").mockResolvedValue({ ok: true, data: [] }));
    expect(await checkInstall({ name, compose: COMPOSE })).toEqual({
      status: 409, error: `A stack named "${name}" already exists. Choose another name, or edit that stack.`,
    });
  });

  test("checkInstall: an existing folder is taken even without a compose file; Docker unreachable is 503", async () => {
    await mkdir(stackDir(name), { recursive: true });
    expect((await checkInstall({ name, compose: COMPOSE }))?.status).toBe(409);
    await rm(stackDir(name), { recursive: true, force: true });
    spies.push(spyOn(DockerClient, "listProjectContainers").mockResolvedValue({ ok: false, error: "socket unavailable" } as never));
    expect((await checkInstall({ name, compose: COMPOSE }))?.status).toBe(503);
  });

  test("a top-level name: that is not the stack's is refused", async () => {
    expect(await checkInstall({ name, compose: `name: other\n${COMPOSE}` })).toEqual({
      status: 422,
      error: `The compose file is named "other", but the stack is "${name}". Make them match, or remove the top-level name:.`,
    });
    expect(await checkInstall({ name, compose: `name: ${name}\n${COMPOSE}` })).toBeNull();
  });
});

describe("redeploy", () => {
  const name = "ops-redeploy";
  beforeEach(async () => {
    await rm(stackDir(name), { recursive: true, force: true });
    await Bun.write(join(stackDir(name), "docker-compose.yml"), "services:\n  old:\n    image: old\n");
    await Bun.write(join(stackDir(name), ".env"), "OLD=1\n");
  });

  test("a file Compose rejects is not left in place: the previous files come back", async () => {
    spies.push(spyOn(processRunner, "capture").mockResolvedValue({ code: 1, stdout: "", stderr: "service \"web\" refers to undefined volume data" }));
    const { job } = await runJob(ctx => runDeploy(ctx, "redeploy", { name, compose: COMPOSE, env: "NEW=1\n" }));
    expect(job.status).toBe("failed");
    expect(job.error).toBe('Docker Compose rejected the file: service "web" refers to undefined volume data');
    expect(await Bun.file(join(stackDir(name), "docker-compose.yml")).text()).toBe("services:\n  old:\n    image: old\n");
    expect(await Bun.file(join(stackDir(name), ".env")).text()).toBe("OLD=1\n");
  });

  test("an omitted .env keeps the current one", async () => {
    const { job } = await runJob(ctx => runDeploy(ctx, "redeploy", { name, compose: "services:\n  web:\n    image: nginx\n" }));
    expect(job.status).toBe("done");
    expect(await Bun.file(join(stackDir(name), ".env")).text()).toBe("OLD=1\n");
  });

  test("checkRedeploy refuses a stack anpan-os has no file for", async () => {
    expect((await checkRedeploy({ name: "ops-never", compose: COMPOSE }))?.status).toBe(404);
    expect(await checkRedeploy({ name, compose: COMPOSE })).toBeNull();
  });
});

describe("update-all", () => {
  beforeEach(async () => {
    for (const n of ["ops-u1", "ops-u2"]) {
      await Bun.write(join(stackDir(n), "docker-compose.yml"), "services:\n  a:\n    image: a\n");
    }
  });

  test("carries on past a failure and names every stack that did not update", async () => {
    let pulls = 0;
    spies.push(spyOn(processRunner, "run").mockImplementation(async (argv, opts) => {
      const cmd = argv.slice(1).join(" ");
      ran.push(`${opts.cwd.split("/").pop()}: ${cmd}`);
      return cmd.endsWith(" pull") && ++pulls === 1 ? 1 : 0;
    }));
    const { job, log } = await runJob(ctx => runUpdateAll(ctx, ["ops-u1", "ops-missing", "ops-u2"]));

    expect(job.status).toBe("failed");
    expect(job.error).toBe("2 of 3 stacks did not update: ops-u1, ops-missing");
    expect(job.progress).toEqual({ done: 3, total: 3 });
    expect(ran).toEqual(["ops-u1: compose -p ops-u1 pull", "ops-u2: compose -p ops-u2 pull", "ops-u2: compose -p ops-u2 up -d"]);
    expect(log).toContain("✓ ops-u2 updated");
  });
});

describe("migrate", () => {
  const name = "ops-migrate";
  beforeEach(async () => { await rm(stackDir(name), { recursive: true, force: true }); });

  test("refuses before writing anything when Docker runs services the file does not define", async () => {
    spies.push(spyOn(DockerClient, "listProjectContainers").mockResolvedValue({
      ok: true, data: [{ Labels: { "com.docker.compose.service": "web" } }, { Labels: { "com.docker.compose.service": "worker" } }],
    } as never));
    const { job } = await runJob(ctx => runMigrate(ctx, name, "services:\n  web:\n    image: x\n", "/var/lib/casaos/apps/x/docker-compose.yml", {}));
    expect(job.status).toBe("failed");
    expect(job.error).toContain("worker");
    expect(await exists(stackDir(name))).toBe(false);
  });

  test("a failed recreate that moved nothing removes the copy and leaves the stack unmanaged", async () => {
    exitCodes = { [`compose -p ${name} up`]: 1 };
    spies.push(spyOn(DockerClient, "listProjectComposeSources").mockResolvedValue({
      ok: true, data: [{ container: "x", configFiles: ["/var/lib/casaos/apps/x/docker-compose.yml"], workingDir: "" }],
    }));
    const { job, log } = await runJob(ctx => runMigrate(ctx, name, "services:\n  web:\n    image: x\n", "/src.yml", { title: "M" }));
    expect(job.status).toBe("failed");
    expect(await exists(stackDir(name))).toBe(false);
    expect((await StackStore.findById(name))?.managed ?? false).toBe(false);
    expect(log.some(l => l.includes("still runs from CasaOS"))).toBe(true);
  });

  test("a failed recreate that moved some containers keeps the copy for Repair", async () => {
    exitCodes = { [`compose -p ${name} up`]: 1 };
    spies.push(spyOn(DockerClient, "listProjectComposeSources").mockResolvedValue({
      ok: true, data: [{ container: "x", configFiles: [join(stackDir(name), "docker-compose.yml")], workingDir: "" }],
    }));
    const { log } = await runJob(ctx => runMigrate(ctx, name, "services:\n  web:\n    image: x\n", "/src.yml", {}));
    expect(await exists(join(stackDir(name), "docker-compose.yml"))).toBe(true);
    expect(log.some(l => l.includes("use Repair"))).toBe(true);
  });

  test("copies the file, records the stack with its metadata, then recreates", async () => {
    const { job } = await runJob(ctx => runMigrate(ctx, name, "services:\n  web:\n    image: x\n", "/src.yml", { title: "Migrated" }));
    expect(job.status).toBe("done");
    expect(await Bun.file(join(stackDir(name), "docker-compose.yml")).text()).toBe("services:\n  web:\n    image: x\n");
    const row = await StackStore.findById(name);
    expect(row?.managed).toBe(true);
    expect(row?.title).toBe("Migrated");
    expect(ran).toEqual([`compose -p ${name} up -d --remove-orphans --force-recreate`]);
  });
});

describe("StackStore.claim", () => {
  test("sets managed on a row the stack poll inserted first, which upsert never did", async () => {
    await StackStore.delete("ops-claim");
    await StackStore.upsert({ id: "ops-claim" });                 // the poll wins the race
    await StackStore.upsert({ id: "ops-claim", managed: true });  // the old install path: no effect
    expect((await StackStore.findById("ops-claim"))?.managed).toBe(false);

    await StackStore.claim("ops-claim", { title: "Mine", icon: undefined });
    const row = await StackStore.findById("ops-claim");
    expect(row?.managed).toBe(true);
    expect(row?.title).toBe("Mine");
  });
});

describe("repair", () => {
  test("refuses to take over an external stack without the caller's consent, checked inside the job", async () => {
    spies.push(spyOn(composeSource, "buildComposeSourceReport").mockResolvedValue({
      stack: "ops-ext", status: "external", needsRepair: false, expected: "/x", expectedExists: false,
      containers: [], foreignPaths: ["/elsewhere/docker-compose.yml"],
    } as never));
    const adopt = spyOn(composeSource, "adoptComposeFile");
    spies.push(adopt);
    const { job } = await runJob(ctx => runRepair(ctx, "ops-ext"));
    expect(job.status).toBe("failed");
    expect(job.error).toContain("managed outside anpan-os");
    expect(adopt).not.toHaveBeenCalled();
  });
});
