/**
 * The HTTP side of jobs: starting one answers 202 with the job, a busy stack answers 409
 * with the job in the way, and /api/jobs shows and cancels them. Docker is faked throughout.
 */
import { test, expect, describe, beforeAll, beforeEach, afterEach, afterAll, spyOn } from "bun:test";
import { rm } from "node:fs/promises";
import { createApp } from "../src/app";
import { TEST_JWT, loginAs } from "./helpers";
import { processRunner, type JobSummary } from "../src/lib/jobs";
import { stackDir } from "../src/lib/stack-ops";
import { commands } from "../src/lib/commands";
import { DockerClient } from "../src/lib/docker";
import { ports as portProvider } from "../src/lib/providers/ports";
import { StackStore } from "../src/stores/stack-store";

const app = createApp(TEST_JWT);
let cookie = "";
beforeAll(async () => { cookie = await loginAs(); });

const spies: Array<{ mockRestore: () => void }> = [];
let releaseUp: () => void = () => {};

beforeEach(() => {
  const upGate = new Promise<void>(r => { releaseUp = r; });
  spies.push(spyOn(commands, "isAvailable").mockResolvedValue(true));
  spies.push(spyOn(processRunner, "capture").mockResolvedValue({ code: 0, stdout: '{"services":{}}', stderr: "" }));
  // `up` waits until the test lets it finish, so the job is still running when it looks.
  spies.push(spyOn(processRunner, "run").mockImplementation(async () => { await upGate; return 0; }));
  spies.push(spyOn(DockerClient, "hasComposeDrift").mockResolvedValue(false));
  spies.push(spyOn(DockerClient, "listProjectContainers").mockResolvedValue({ ok: true, data: [] }));
  spies.push(spyOn(DockerClient, "listContainers").mockResolvedValue({ ok: true, data: [] }));
  spies.push(spyOn(portProvider, "listeners").mockResolvedValue([]));
});
afterEach(() => { releaseUp(); while (spies.length) spies.pop()!.mockRestore(); });
afterAll(async () => {
  for (const name of ["route-job", "route-cancel"]) {
    await rm(stackDir(name), { recursive: true, force: true });
    await StackStore.delete(name);
  }
});

async function call(method: string, path: string, body?: unknown) {
  const res = await app.handle(new Request(`http://localhost${path}`, {
    method,
    headers: { cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

async function finished(id: string): Promise<JobSummary> {
  for (let i = 0; i < 400; i++) {
    const { body } = await call("GET", `/api/jobs/${id}`);
    const job = body.job as JobSummary;
    if (job.status !== "running") return job;
    await Bun.sleep(5);
  }
  throw new Error("job did not finish");
}

const COMPOSE = "services:\n  web:\n    image: nginx\n";

describe("install through the route", () => {
  const name = "route-job";
  beforeEach(async () => { await rm(stackDir(name), { recursive: true, force: true }); await StackStore.delete(name); });

  test("answers 202 with a running job; a second request for the stack gets 409 and that job", async () => {
    const first = await call("POST", "/api/compose/stacks", { name, content: COMPOSE, meta: { title: "Route" } });
    expect(first.status).toBe(202);
    const job = first.body.job as JobSummary;
    expect(job).toMatchObject({ kind: "install", stack: name, status: "running" });

    // While the first install holds the stack, a redeploy of it is turned away.
    for (let i = 0; i < 100 && !(await Bun.file(`${stackDir(name)}/docker-compose.yml`).exists()); i++) await Bun.sleep(5);
    const second = await call("PUT", `/api/compose/stacks/${name}/file`, { content: COMPOSE });
    expect(second.status).toBe(409);
    expect((second.body.job as JobSummary).id).toBe(job.id);

    releaseUp();
    expect((await finished(job.id)).status).toBe("done");
    expect((await StackStore.findById(name))?.title).toBe("Route");

    const { body } = await call("GET", `/api/jobs/${job.id}`);
    expect(body.log).toContain("▶ Starting containers");
  });

  test("an invalid compose file is refused with 422 and no job", async () => {
    const res = await call("POST", "/api/compose/stacks", { name, content: "services: {}" });
    expect(res.status).toBe(422);
    expect(res.body.job).toBeUndefined();
  });
});

describe("/api/jobs", () => {
  test("lists jobs, and cancels a running one", async () => {
    const name = "route-cancel";
    await rm(stackDir(name), { recursive: true, force: true });
    // `up` runs until cancelled; the clean-up `down` that follows a cancelled install ends at once.
    spies.push(spyOn(processRunner, "run").mockImplementation((argv, opts) => argv.includes("down")
      ? Promise.resolve(0)
      : new Promise<number>(resolve => {
        opts.signal.addEventListener("abort", () => resolve(137), { once: true });
      })));
    const started = await call("POST", "/api/compose/stacks", { name, content: COMPOSE });
    const job = started.body.job as JobSummary;

    const list = await call("GET", "/api/jobs");
    expect((list.body.jobs as JobSummary[]).some(j => j.id === job.id)).toBe(true);

    expect((await call("POST", `/api/jobs/${job.id}/cancel`)).status).toBe(200);
    expect((await finished(job.id)).status).toBe("cancelled");
    expect((await call("POST", `/api/jobs/${job.id}/cancel`)).status).toBe(409);
  });

  test("an unknown job is 404", async () => {
    expect((await call("GET", "/api/jobs/nope")).status).toBe(404);
    expect((await call("POST", "/api/jobs/nope/cancel")).status).toBe(404);
  });

  test("the stream opens with a snapshot of every job", async () => {
    const controller = new AbortController();
    const res = await app.handle(new Request("http://localhost/api/jobs/stream", { headers: { cookie }, signal: controller.signal }));
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    controller.abort();
    // In-process, Elysia may hand the chunk over as a string rather than bytes.
    const text = typeof value === "string" ? value : new TextDecoder().decode(value);
    expect(text).toContain('"type":"snapshot"');
    expect(text).toContain('"jobs":[');
  });

  test("needs a session", async () => {
    const res = await app.handle(new Request("http://localhost/api/jobs"));
    expect(res.status).toBe(401);
  });
});

describe("update-all", () => {
  test("starts one job over the stacks; a bad name is 422", async () => {
    expect((await call("POST", "/api/compose/update-all", { stacks: ["ok", "../x"] })).status).toBe(422);
    const res = await call("POST", "/api/compose/update-all", { stacks: ["route-missing-a", "route-missing-b"] });
    expect(res.status).toBe(202);
    const job = await finished((res.body.job as JobSummary).id);
    expect(job.kind).toBe("update-all");
    expect(job.error).toBe("2 of 2 stacks did not update: route-missing-a, route-missing-b");
  });
});
