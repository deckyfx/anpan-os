import { Elysia, sse } from "elysia";
import { authGuard } from "./authGuard";
import { jobs, type JobEvent, type JobSummary } from "../lib/jobs";
import { Broadcast, mergeStreams } from "../lib/broadcast";

/**
 * Job routes: follow and cancel the stack operations that run in the server.
 *
 * GET  /api/jobs            — every job held, newest first
 * GET  /api/jobs/stream     — SSE: a snapshot of all jobs, then job and log events
 * GET  /api/jobs/:id        — one job with the log lines held so far
 * POST /api/jobs/:id/cancel — stop a running job
 *
 * A job is started by the route for its operation (install, redeploy, update, migrate,
 * repair), which answers 202 with the job. These routes only watch.
 */
export function jobsPlugin(jwtSecret: string) {
  return new Elysia({ prefix: "/api/jobs" })
    .use(authGuard(jwtSecret))

    .get("/", () => ({ jobs: jobs.list() }), {
      detail: { summary: "List jobs, newest first" },
    })

    /**
     * Attach before taking the snapshot, as the update-check stream does: anything published
     * while the snapshot is read is then queued for this client rather than lost.
     *
     * Log events carry a sequence number. A client showing one job's log reads it with
     * GET /:id and keeps only the streamed lines past the last one it has.
     */
    .get("/stream", async function*({ request }) {
      const subscription = jobs.attach(request.signal);
      const keepalive = new Broadcast<JobEvent>();
      const timer = setInterval(() => keepalive.publish({ type: "heartbeat" }), 25_000);
      request.signal.addEventListener("abort", () => { clearInterval(timer); keepalive.closeAll(); }, { once: true });

      try {
        yield sse({ data: { type: "snapshot" as const, jobs: jobs.list() } satisfies { type: "snapshot"; jobs: JobSummary[] } });
        for await (const event of mergeStreams(subscription.events, keepalive.subscribe(request.signal))) {
          yield sse({ data: event });
        }
      } finally {
        clearInterval(timer);
        keepalive.closeAll();
        subscription.detach();
      }
    }, {
      detail: { summary: "Follow jobs as server-sent events" },
    })

    .get("/:id", ({ params, set }) => {
      const found = jobs.get(params.id);
      if (!found) { set.status = 404; return { error: "No such job (finished jobs are kept for a while only)" }; }
      return found;
    }, {
      detail: { summary: "One job, with the log lines held so far" },
    })

    .post("/:id/cancel", ({ params, set }) => {
      if (!jobs.get(params.id)) { set.status = 404; return { error: "No such job" }; }
      if (!jobs.cancel(params.id)) { set.status = 409; return { error: "The job has already finished" }; }
      return { ok: true };
    }, {
      detail: { summary: "Cancel a running job" },
    });
}
