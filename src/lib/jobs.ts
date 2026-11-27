/**
 * Server-side jobs: long stack operations (install, redeploy, update, migrate, repair)
 * that run in the server and report to any number of watching browsers.
 *
 * These operations used to run inside the HTTP request that started them, streaming the
 * subprocess to that one client. Closing the tab lost the steps the browser still had to
 * send, and a client that stopped reading stalled the subprocess once the stream's buffer
 * filled. A job belongs to the server instead: the request that starts it returns at once,
 * the work continues whatever happens to the browser, and progress is published through a
 * {@link Broadcast}, which never waits on a reader. A page opened later reads a job's log so
 * far and follows it from there.
 *
 * One job at a time per stack. Two installs of one name, or an update during an edit, would
 * otherwise race on the same compose file and the same containers.
 *
 * Jobs live in memory. A job is a `docker compose` run owned by this process; if the process
 * restarts, the run is gone with it, and the stack's own log file is what remains.
 */
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { join } from "node:path";
import { Broadcast } from "./broadcast";
import { envConfig } from "../env-config";

export type JobKind = "install" | "redeploy" | "update" | "update-all" | "migrate" | "repair";
export type JobStatus = "running" | "done" | "failed" | "cancelled";

/** What the browser is told about a job. */
export interface JobSummary {
  id:         string;
  kind:       JobKind;
  /** Short description for lists, e.g. "Install jellyfin". */
  title:      string;
  /** The stack this job holds; null for a job over several stacks (update-all). */
  stack:      string | null;
  status:     JobStatus;
  /** The step in progress, e.g. "Checking ports". */
  step:       string;
  /** Set by jobs over several items. */
  progress:   { done: number; total: number } | null;
  startedAt:  number;
  finishedAt: number | null;
  error:      string | null;
  /** Number of log lines written so far, which is also the next line's sequence number. */
  lines:      number;
}

export type JobEvent =
  | { type: "job"; job: JobSummary }
  | { type: "log"; jobId: string; seq: number; line: string }
  | { type: "heartbeat" };

/** A failure whose message is meant for the user as it stands, with no stack trace. */
export class JobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobError";
  }
}

/**
 * Runs a subprocess and hands over its output line by line.
 *
 * An object rather than a bare function so tests can replace `run` and never reach Docker.
 */
export const processRunner = {
  /** Run `argv` in `cwd`; resolves with the exit code. Killed when `signal` aborts. */
  async run(argv: string[], opts: { cwd: string; signal: AbortSignal; onLine: (line: string) => void }): Promise<number> {
    const proc = Bun.spawn(argv, { cwd: opts.cwd, stdout: "pipe", stderr: "pipe" });
    const kill = () => proc.kill();
    if (opts.signal.aborted) kill();
    else opts.signal.addEventListener("abort", kill, { once: true });
    try {
      const [, , code] = await Promise.all([
        readLines(proc.stdout, opts.onLine),
        readLines(proc.stderr, opts.onLine),
        proc.exited,
      ]);
      return code;
    } finally {
      opts.signal.removeEventListener("abort", kill);
    }
  },

  /** Run `argv` in `cwd` and collect its output, for commands whose stdout is data. */
  async capture(argv: string[], opts: { cwd: string; signal: AbortSignal }): Promise<{ code: number; stdout: string; stderr: string }> {
    const proc = Bun.spawn(argv, { cwd: opts.cwd, stdout: "pipe", stderr: "pipe" });
    const kill = () => proc.kill();
    if (opts.signal.aborted) kill();
    else opts.signal.addEventListener("abort", kill, { once: true });
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { code, stdout, stderr };
    } finally {
      opts.signal.removeEventListener("abort", kill);
    }
  },
};

/** Calls `onLine` for each non-empty line of `stream`. Never waits on the consumer. */
async function readLines(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void): Promise<void> {
  const decoder = new TextDecoder();
  let rest = "";
  for await (const chunk of stream) {
    rest += decoder.decode(chunk, { stream: true });
    const lines = rest.split("\n");
    rest = lines.pop() ?? "";
    for (const line of lines) if (line.trim()) onLine(line);
  }
  rest += decoder.decode();
  if (rest.trim()) onLine(rest);
}

/** Lines kept per job. Older ones are dropped; the stack's log file keeps them all. */
const MAX_LOG_LINES = 5000;
/** Finished jobs kept for late viewers. */
const KEEP_FINISHED = 50;

interface Job {
  summary:  JobSummary;
  log:      string[];
  /** Sequence number of `log[0]`, which rises once lines are dropped. */
  firstSeq: number;
  abort:    AbortController;
}

/** The path of a stack's persisted operation log, shown as its install log. */
export function stackLogPath(stack: string): string {
  return join(envConfig.RUNTIME_CONFIG_DIR, "logs", `${stack}.log`);
}

/** Handed to a job's body: logging, steps, subprocesses and cancellation. */
export class JobContext {
  private logFile: WriteStream | null = null;

  constructor(private readonly job: Job, private readonly manager: JobManager) {}

  /** Aborted when the job is cancelled. */
  get signal(): AbortSignal {
    return this.job.abort.signal;
  }

  /** Throws when the job was cancelled, so a body can stop between steps. */
  throwIfCancelled(): void {
    if (this.signal.aborted) throw new JobError("Cancelled");
  }

  /** Add a line to the job's log, and to the stack log file when one is open. */
  log(line: string): void {
    this.manager.appendLog(this.job, line);
    this.logFile?.write(line + "\n");
  }

  /** Name the step now running. Also logged, so the log reads as a sequence. */
  step(name: string): void {
    this.manager.update(this.job, { step: name });
    this.log(`▶ ${name}`);
  }

  progress(done: number, total: number): void {
    this.manager.update(this.job, { progress: { done, total } });
  }

  /**
   * Send this job's output to `stack`'s log file as well, under a header naming the
   * operation. Replaces any file already open; pass null to stop.
   */
  logToStack(stack: string | null, label?: string): void {
    this.logFile?.end();
    this.logFile = null;
    if (!stack) return;
    const path = stackLogPath(stack);
    mkdirSync(join(path, ".."), { recursive: true });
    const file = createWriteStream(path, { flags: "a" });
    // A stream reports a failed open or write as an "error" event, later, outside any
    // try/catch; unhandled, it would end the process. The job carries on: its log is still
    // kept in memory, only the copy on disk stops.
    file.on("error", err => {
      if (this.logFile === file) this.logFile = null;
      this.manager.appendLog(this.job, `(Could not write the log file ${path}: ${err.message})`);
    });
    this.logFile = file;
    file.write(`--- ${label ?? this.job.summary.kind} ${new Date().toISOString()} ---\n`);
  }

  /**
   * Run a command, logging its output. Throws a {@link JobError} naming the command when it
   * exits non-zero, and when the job is cancelled.
   */
  async exec(argv: string[], cwd: string, what?: string): Promise<void> {
    this.throwIfCancelled();
    const code = await processRunner.run(argv, { cwd, signal: this.signal, onLine: line => this.log(line) });
    this.throwIfCancelled();
    if (code !== 0) throw new JobError(`${what ?? argv.slice(0, 3).join(" ")} failed (exit code ${code})`);
  }

  /**
   * Hold `stack` while `fn` runs, for a job over several stacks.
   *
   * Returns false without running `fn` when another job holds the stack. A bulk update then
   * skips that stack rather than waiting behind, say, a long install.
   */
  async withStack(stack: string, fn: () => Promise<void>): Promise<boolean> {
    if (!this.manager.claim(stack, this.job.summary.id)) return false;
    try {
      await fn();
    } finally {
      this.manager.release(stack, this.job.summary.id);
    }
    return true;
  }

  /** Close the log file. Called by the manager when the job ends. */
  close(): void {
    this.logToStack(null);
  }
}

export interface JobSpec {
  kind:  JobKind;
  title: string;
  /** The stack to hold for the whole job; its operations are also logged to its file. */
  stack?: string;
}

/** Starts, tracks and publishes jobs. Use the shared {@link jobs} instance. */
export class JobManager {
  private readonly all = new Map<string, Job>();
  /** Stack name → id of the job holding it. */
  private readonly holders = new Map<string, string>();
  private readonly events = new Broadcast<JobEvent>();
  private counter = 0;

  /**
   * Start a job running `body` in the background.
   *
   * Refused, with the job in the way, when `spec.stack` is already held: the caller answers
   * 409 and the client can show that job instead.
   */
  start(spec: JobSpec, body: (ctx: JobContext) => Promise<void>):
    { ok: true; job: JobSummary } | { ok: false; busyWith: JobSummary } {
    const id = `${Date.now().toString(36)}-${(++this.counter).toString(36)}`;
    if (spec.stack) {
      const holder = this.activeFor(spec.stack);
      if (holder) return { ok: false, busyWith: holder };
    }

    const job: Job = {
      summary: {
        id, kind: spec.kind, title: spec.title, stack: spec.stack ?? null,
        status: "running", step: "Starting", progress: null,
        startedAt: Date.now(), finishedAt: null, error: null, lines: 0,
      },
      log: [],
      firstSeq: 0,
      abort: new AbortController(),
    };
    this.all.set(id, job);
    if (spec.stack) this.claim(spec.stack, id);
    this.publish(job);

    const ctx = new JobContext(job, this);

    void (async () => {
      try {
        // Inside the try: a log folder that cannot be created must fail this job and give
        // its stack back, not leave a job "running" forever with the stack held.
        if (spec.stack) ctx.logToStack(spec.stack);
        await body(ctx);
        this.finish(job, ctx, job.abort.signal.aborted ? "cancelled" : "done", null);
      } catch (err) {
        const cancelled = job.abort.signal.aborted;
        const message = err instanceof JobError || err instanceof Error ? err.message : String(err);
        if (!cancelled && !(err instanceof JobError)) console.error(`[jobs] ${spec.title}:`, err);
        ctx.log(cancelled ? "✕ Cancelled" : `✕ ${message}`);
        this.finish(job, ctx, cancelled ? "cancelled" : "failed", cancelled ? null : message);
      }
    })();

    return { ok: true, job: { ...job.summary } };
  }

  /** A job's summary and the log lines still held, oldest first. */
  get(id: string): { job: JobSummary; firstSeq: number; log: string[] } | null {
    const job = this.all.get(id);
    return job ? { job: { ...job.summary }, firstSeq: job.firstSeq, log: [...job.log] } : null;
  }

  /** Every job held, newest first. */
  list(): JobSummary[] {
    return [...this.all.values()].reverse().map(j => ({ ...j.summary }));
  }

  /** The running job holding `stack`, if any. */
  activeFor(stack: string): JobSummary | null {
    const id = this.holders.get(stack);
    const job = id ? this.all.get(id) : undefined;
    return job && job.summary.status === "running" ? { ...job.summary } : null;
  }

  /** Ask a running job to stop. Its subprocess is killed; the job ends as cancelled. */
  cancel(id: string): boolean {
    const job = this.all.get(id);
    if (!job || job.summary.status !== "running") return false;
    job.abort.abort();
    return true;
  }

  /** Subscribe to job events from now on; see {@link Broadcast.attach}. */
  attach(signal?: AbortSignal): ReturnType<Broadcast<JobEvent>["attach"]> {
    return this.events.attach(signal);
  }

  /** @internal Used by {@link JobContext}. */
  appendLog(job: Job, line: string): void {
    const seq = job.summary.lines++;
    job.log.push(line);
    if (job.log.length > MAX_LOG_LINES) {
      job.log.shift();
      job.firstSeq++;
    }
    this.events.publish({ type: "log", jobId: job.summary.id, seq, line });
  }

  /** @internal Used by {@link JobContext}. */
  update(job: Job, patch: Partial<Pick<JobSummary, "step" | "progress">>): void {
    Object.assign(job.summary, patch);
    this.publish(job);
  }

  /** @internal Take `stack` for job `id`; false when another job holds it. */
  claim(stack: string, id: string): boolean {
    const holder = this.holders.get(stack);
    if (holder && holder !== id && this.all.get(holder)?.summary.status === "running") return false;
    this.holders.set(stack, id);
    return true;
  }

  /** @internal Give `stack` back, if job `id` holds it. */
  release(stack: string, id: string): void {
    if (this.holders.get(stack) === id) this.holders.delete(stack);
  }

  private finish(job: Job, ctx: JobContext, status: JobStatus, error: string | null): void {
    ctx.close();
    Object.assign(job.summary, { status, error, finishedAt: Date.now(), step: status === "done" ? "Done" : job.summary.step });
    for (const [stack, holder] of this.holders) if (holder === job.summary.id) this.holders.delete(stack);
    this.publish(job);
    this.prune();
  }

  private publish(job: Job): void {
    this.events.publish({ type: "job", job: { ...job.summary } });
  }

  /** Drop the oldest finished jobs beyond {@link KEEP_FINISHED}. */
  private prune(): void {
    const finished = [...this.all.values()].filter(j => j.summary.status !== "running");
    for (const job of finished.slice(0, Math.max(0, finished.length - KEEP_FINISHED))) {
      this.all.delete(job.summary.id);
    }
  }
}

/** The server's job manager. */
export const jobs = new JobManager();
