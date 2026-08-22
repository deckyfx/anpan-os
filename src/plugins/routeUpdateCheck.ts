import { Elysia, t, sse } from "elysia";
import { authGuard } from "./authGuard";
import { updateChecker } from "../lib/update-checker";
import { UpdateCheckStore } from "../stores/update-check-store";
import type { CheckerEvent } from "../lib/update-checker";

/**
 * Image update-check routes.
 *
 * These are a thin shell over {@link updateChecker}: starting a sweep answers immediately
 * with whether one began, and the stream only subscribes. The sweep itself belongs to the
 * checker, so no client can cancel it by navigating away — the defect this replaced.
 */

/** What a late-joining subscriber needs before deltas make sense. */
async function snapshot() {
  const [run, results] = await Promise.all([
    UpdateCheckStore.lastRun(),
    UpdateCheckStore.allState(),
  ]);
  return {
    type: "snapshot" as const,
    running: updateChecker.running,
    run,
    results,
  };
}

export function updateCheckPlugin(jwtSecret: string) {
  return new Elysia({ prefix: "/api/docker" })
    .use(authGuard(jwtSecret))

    /**
     * POST /api/docker/update-check/start
     *
     * Returns at once rather than holding the request open for the sweep. `auto` requests
     * are dropped when a recent run exists, so several dashboard tabs opening together do
     * not each trigger work; `force` cancels an in-flight sweep and restarts in one step,
     * which the UI cannot do safely as two calls.
     */
    .post("/update-check/start", async ({ body }) => {
      const outcome = await updateChecker.start({
        auto:  body?.auto  ?? false,
        force: body?.force ?? false,
        // A named stack narrows the sweep. Scoped runs skip the staleness gate: asking
        // about one stack is always deliberate, never an automatic dashboard refresh.
        ...(body?.stack ? { stack: body.stack } : {}),
      });
      return outcome;
    }, { body: t.Optional(t.Object({
      auto:  t.Optional(t.Boolean()),
      force: t.Optional(t.Boolean()),
      stack: t.Optional(t.String()),
    })) })

    /** POST /api/docker/update-check/cancel — stop the sweep; results so far are kept. */
    .post("/update-check/cancel", async () => {
      const cancelled = await updateChecker.cancel();
      return { cancelled };
    })

    /**
     * GET /api/docker/update-check/stream
     *
     * Sends a snapshot first, then live events. Without the snapshot a tab opened
     * mid-sweep would show nothing until the next image happened to finish.
     */
    .get("/update-check/stream", async function*({ request }) {
      yield sse({ data: await snapshot() });
      for await (const event of updateChecker.subscribe(request.signal)) {
        yield sse({ data: event satisfies CheckerEvent });
      }
    })

    /** GET /api/docker/update-check/report — last run plus current per-image state. */
    .get("/update-check/report", async () => {
      const [run, results, runs] = await Promise.all([
        UpdateCheckStore.lastRun(),
        UpdateCheckStore.allState(),
        UpdateCheckStore.listRuns(),
      ]);
      return {
        running: updateChecker.running,
        run,
        runs,
        results,
        updatesFound: results.filter(r => r.hasUpdate).length,
      };
    })

    /** GET /api/docker/update-check/outdated — just the images with updates, for badges. */
    .get("/update-check/outdated", async () => {
      return { results: await UpdateCheckStore.outdated() };
    })

    /**
     * DELETE /api/docker/update-check — clear stored results and run history.
     *
     * Refused while a sweep is running: the sweep would immediately write rows back, so
     * the user would see the table repopulate and reasonably conclude it had not worked.
     */
    .delete("/update-check", async ({ set }) => {
      if (updateChecker.running) {
        set.status = 409;
        return { error: "A check is running — cancel it before clearing results" };
      }
      return await UpdateCheckStore.purge();
    });
}
