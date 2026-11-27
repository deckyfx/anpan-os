import { create } from "zustand";
import { api } from "../lib/api";
import { useStacksStore } from "./stacksStore";

/**
 * Server-side jobs (install, redeploy, update, migrate, repair), followed live.
 *
 * The jobs run in the server and outlive this page, so this store reflects them rather
 * than driving them: it holds one stream to /api/jobs/stream, keeps every job's summary,
 * and keeps the log of each job something on the page is showing.
 *
 * A log is read with GET /api/jobs/:id and then extended from the stream. Every log event
 * carries its line's sequence number, so a line already read is not added twice, and a gap
 * (say, after a reconnect) triggers a fresh read instead of a silently incomplete log.
 */

export type JobKind = "install" | "redeploy" | "update" | "update-all" | "migrate" | "repair";
export type JobStatus = "running" | "done" | "failed" | "cancelled";

export interface JobSummary {
  id:         string;
  kind:       JobKind;
  title:      string;
  stack:      string | null;
  status:     JobStatus;
  step:       string;
  progress:   { done: number; total: number } | null;
  startedAt:  number;
  finishedAt: number | null;
  error:      string | null;
  lines:      number;
}

/** A job's log as held here: `lines[0]` has sequence number `firstSeq`. */
export interface JobLog {
  firstSeq: number;
  lines:    string[];
}

type StreamEvent =
  | { type: "snapshot"; jobs: JobSummary[] }
  | { type: "job"; job: JobSummary }
  | { type: "log"; jobId: string; seq: number; line: string }
  | { type: "heartbeat" };

/** The answer of a route that starts a job: 202 with it, or 409 with the job in the way. */
export type StartAnswer = { job: JobSummary } | { error: string; job?: JobSummary };

/** Lines kept per watched log, matching the server's own limit. */
const MAX_LINES = 5000;

interface JobsApi {
  stream: { get: (o: unknown) => Promise<{ data: AsyncIterable<{ data: StreamEvent }> | null; error: unknown }> };
}
const jobsApi = (): JobsApi => api.api.jobs as unknown as JobsApi;

let _abort: AbortController | null = null;
let _retry = 0;
let _retryTimer: ReturnType<typeof setTimeout> | null = null;
/** How many components show each job's log; logs nobody shows are dropped. */
const watchers = new Map<string, number>();

interface JobsState {
  connected: boolean;
  /** Every job the server holds, by id. */
  jobs: Record<string, JobSummary>;
  /** Logs of the jobs being shown, by id. */
  logs: Record<string, JobLog>;

  connect:    () => void;
  disconnect: () => void;
  /** Record a job a route just answered with, before its first stream event arrives. */
  track:      (job: JobSummary) => void;
  /** Start keeping `id`'s log; returns the function that stops. */
  watch:      (id: string) => () => void;
  cancel:     (id: string) => Promise<void>;
}

/** Jobs that finished since this page connected, so their side effects run once. */
const settled = new Set<string>();

/**
 * A job finished: refresh what it changed. The stacks list for anything that ran
 * Compose; the update badges are left to the update checker, which rechecks a stack
 * when it is redeployed.
 */
function onSettled(job: JobSummary): void {
  if (settled.has(job.id)) return;
  settled.add(job.id);
  void useStacksStore.getState().loadStacks();
}

async function readLog(id: string): Promise<JobLog | null> {
  const { data } = await api.api.jobs({ id }).get();
  const found = data as { firstSeq: number; log: string[] } | null;
  return found && Array.isArray(found.log) ? { firstSeq: found.firstSeq, lines: found.log } : null;
}

export const useJobsStore = create<JobsState>((set, get) => {
  /** Read `id`'s log from the server and replace what is held. */
  const refetch = async (id: string) => {
    const log = await readLog(id).catch(() => null);
    if (log && watchers.has(id)) set(s => ({ logs: { ...s.logs, [id]: log } }));
  };

  const applyLine = (jobId: string, seq: number, line: string) => {
    const log = get().logs[jobId];
    if (!log) return;                          // not shown here
    const next = log.firstSeq + log.lines.length;
    if (seq < next) return;                    // already read
    if (seq > next) { void refetch(jobId); return; }
    const lines = [...log.lines, line];
    const drop = Math.max(0, lines.length - MAX_LINES);
    set(s => ({ logs: { ...s.logs, [jobId]: { firstSeq: log.firstSeq + drop, lines: drop ? lines.slice(drop) : lines } } }));
  };

  return {
    connected: false,
    jobs: {},
    logs: {},

    connect: () => {
      if (_abort) return;
      const controller = new AbortController();
      _abort = controller;
      const { signal } = controller;

      void (async () => {
        try {
          const { data, error } = await jobsApi().stream.get({ fetch: { signal } });
          if (error || !data) { set({ connected: false }); return; }
          set({ connected: true });
          _retry = 0;

          for await (const event of data) {
            if (signal.aborted) break;
            const msg = event.data;
            if (!msg) continue;
            switch (msg.type) {
              case "snapshot": {
                const jobs = Object.fromEntries(msg.jobs.map(j => [j.id, j]));
                // Jobs that ended while disconnected still need their side effects.
                for (const j of msg.jobs) if (j.status !== "running" && get().jobs[j.id]?.status === "running") onSettled(j);
                set({ jobs });
                for (const id of watchers.keys()) void refetch(id);
                break;
              }
              case "job":
                set(s => ({ jobs: { ...s.jobs, [msg.job.id]: msg.job } }));
                if (msg.job.status !== "running") onSettled(msg.job);
                break;
              case "log":
                applyLine(msg.jobId, msg.seq, msg.line);
                break;
              case "heartbeat":
                break;
            }
          }
        } catch {
          // Navigating away aborts the fetch; not an error worth surfacing.
        } finally {
          if (_abort === controller) _abort = null;
          if (!signal.aborted) {
            set({ connected: false });
            _retry = Math.min(_retry ? _retry * 2 : 1_000, 30_000);
            _retryTimer = setTimeout(() => { _retryTimer = null; get().connect(); }, _retry);
          }
        }
      })();
    },

    disconnect: () => {
      if (_retryTimer) { clearTimeout(_retryTimer); _retryTimer = null; }
      _retry = 0;
      _abort?.abort();
      _abort = null;
      set({ connected: false });
    },

    track: (job) => {
      set(s => (s.jobs[job.id] && s.jobs[job.id]!.lines >= job.lines ? {} : { jobs: { ...s.jobs, [job.id]: job } }));
    },

    watch: (id) => {
      watchers.set(id, (watchers.get(id) ?? 0) + 1);
      if (!get().logs[id]) {
        set(s => ({ logs: { ...s.logs, [id]: { firstSeq: 0, lines: [] } } }));
        void refetch(id);
      }
      return () => {
        const n = (watchers.get(id) ?? 1) - 1;
        if (n > 0) { watchers.set(id, n); return; }
        watchers.delete(id);
        set(s => {
          const { [id]: _dropped, ...rest } = s.logs;
          return { logs: rest };
        });
      };
    },

    cancel: async (id) => {
      await api.api.jobs({ id }).cancel.post();
    },
  };
});

/** The job running for `stack`, if any. */
export function runningJobFor(jobs: Record<string, JobSummary>, stack: string): JobSummary | null {
  return Object.values(jobs).find(j => j.stack === stack && j.status === "running") ?? null;
}

/**
 * Read a job-starting route's answer: the job (started, or the one already holding the
 * stack) and the error to show, if any.
 */
export function readStartAnswer(data: unknown, error: unknown): { job: JobSummary | null; error: string | null } {
  const ok = data as { job?: JobSummary } | null;
  if (ok?.job) {
    useJobsStore.getState().track(ok.job);
    return { job: ok.job, error: null };
  }
  const value = (error as { value?: { error?: string; job?: JobSummary } } | null)?.value;
  if (value?.job) useJobsStore.getState().track(value.job);
  return { job: value?.job ?? null, error: value?.error ?? "The request failed" };
}
