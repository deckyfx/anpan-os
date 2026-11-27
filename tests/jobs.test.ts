/**
 * The job engine behind installs, redeploys, updates, migrations and repairs.
 *
 * What it promises: one job per stack, work that does not depend on anyone watching, a log
 * a late viewer can read and then follow without gaps, and cancellation that stops the
 * subprocess.
 */
import { test, expect, describe, afterEach, spyOn } from "bun:test";
import { JobManager, JobError, processRunner, type JobEvent, type JobSummary } from "../src/lib/jobs";

/** Wait until job `id` has finished. */
async function settled(manager: JobManager, id: string): Promise<JobSummary> {
  for (let i = 0; i < 200; i++) {
    const job = manager.get(id)?.job;
    if (job && job.status !== "running") return job;
    await Bun.sleep(5);
  }
  throw new Error(`job ${id} did not finish`);
}

const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => { while (spies.length) spies.pop()!.mockRestore(); });

describe("JobManager", () => {
  test("a job runs to done, with its steps and lines in the log", async () => {
    const manager = new JobManager();
    const started = manager.start({ kind: "install", title: "Install a" }, async ctx => {
      ctx.step("Writing files");
      ctx.log("wrote it");
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const job = await settled(manager, started.job.id);
    expect(job.status).toBe("done");
    expect(job.error).toBeNull();
    expect(manager.get(job.id)!.log).toEqual(["▶ Writing files", "wrote it"]);
  });

  test("a JobError fails the job with its message as the error", async () => {
    const manager = new JobManager();
    const started = manager.start({ kind: "install", title: "Install b" }, async () => {
      throw new JobError("Port conflict: port 80/tcp");
    });
    if (!started.ok) throw new Error("not started");
    const job = await settled(manager, started.job.id);
    expect(job.status).toBe("failed");
    expect(job.error).toBe("Port conflict: port 80/tcp");
  });

  test("a second job for the same stack is refused while the first runs, and allowed after", async () => {
    const manager = new JobManager();
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const first = manager.start({ kind: "install", title: "Install c", stack: "c" }, () => gate);
    if (!first.ok) throw new Error("not started");

    const second = manager.start({ kind: "redeploy", title: "Redeploy c", stack: "c" }, async () => {});
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.busyWith.id).toBe(first.job.id);
    expect(manager.activeFor("c")?.id).toBe(first.job.id);

    // Other stacks are not held up.
    expect(manager.start({ kind: "install", title: "Install d", stack: "d" }, async () => {}).ok).toBe(true);

    release();
    await settled(manager, first.job.id);
    expect(manager.activeFor("c")).toBeNull();
    expect(manager.start({ kind: "redeploy", title: "Redeploy c", stack: "c" }, async () => {}).ok).toBe(true);
  });

  test("log events carry sequence numbers continuing from the lines already held", async () => {
    const manager = new JobManager();
    const sub = manager.attach();
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const started = manager.start({ kind: "update", title: "Update e" }, async ctx => {
      ctx.log("one");
      await gate;
      ctx.log("two");
    });
    if (!started.ok) throw new Error("not started");
    await Bun.sleep(5);

    // A late viewer reads what is held, then keeps only events past it.
    const held = manager.get(started.job.id)!;
    expect(held.log).toEqual(["one"]);
    expect(held.firstSeq + held.log.length).toBe(1);

    release();
    await settled(manager, started.job.id);
    sub.detach();
    const events: JobEvent[] = [];
    for await (const e of sub.events) events.push(e);
    const logs = events.filter(e => e.type === "log");
    expect(logs.map(e => e.type === "log" && [e.seq, e.line])).toEqual([[0, "one"], [1, "two"]]);
  });

  test("cancel kills the running command and ends the job as cancelled", async () => {
    const manager = new JobManager();
    let killed = false;
    spies.push(spyOn(processRunner, "run").mockImplementation((_argv, opts) => new Promise<number>(resolve => {
      opts.signal.addEventListener("abort", () => { killed = true; resolve(137); }, { once: true });
    })));

    const started = manager.start({ kind: "update", title: "Update f", stack: "f" }, async ctx => {
      await ctx.exec(["docker", "compose", "pull"], "/tmp");
    });
    if (!started.ok) throw new Error("not started");
    await Bun.sleep(5);
    expect(manager.cancel(started.job.id)).toBe(true);

    const job = await settled(manager, started.job.id);
    expect(killed).toBe(true);
    expect(job.status).toBe("cancelled");
    expect(job.error).toBeNull();
    expect(manager.cancel(started.job.id)).toBe(false);
  });

  test("a command that exits non-zero fails the job naming the command", async () => {
    const manager = new JobManager();
    spies.push(spyOn(processRunner, "run").mockImplementation(async (_argv, opts) => {
      opts.onLine("Error: pull access denied");
      return 1;
    }));
    const started = manager.start({ kind: "update", title: "Update g" }, ctx =>
      ctx.exec(["docker", "compose", "pull"], "/tmp", "docker compose pull"));
    if (!started.ok) throw new Error("not started");
    const job = await settled(manager, started.job.id);
    expect(job.error).toBe("docker compose pull failed (exit code 1)");
    expect(manager.get(job.id)!.log).toContain("Error: pull access denied");
  });

  test("withStack skips a stack another job holds", async () => {
    const manager = new JobManager();
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const holder = manager.start({ kind: "install", title: "Install h", stack: "h" }, () => gate);
    if (!holder.ok) throw new Error("not started");

    const ran: string[] = [];
    const bulk = manager.start({ kind: "update-all", title: "Update 2 stacks" }, async ctx => {
      for (const name of ["h", "i"]) {
        const ok = await ctx.withStack(name, async () => { ran.push(name); });
        if (!ok) ctx.log(`skipped ${name}`);
      }
    });
    if (!bulk.ok) throw new Error("not started");
    await settled(manager, bulk.job.id);
    expect(ran).toEqual(["i"]);
    expect(manager.get(bulk.job.id)!.log).toContain("skipped h");
    // The bulk job gave "i" back.
    expect(manager.activeFor("i")).toBeNull();
    release();
  });
});
