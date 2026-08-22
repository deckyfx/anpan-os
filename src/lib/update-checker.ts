/**
 * Background image-update checker.
 *
 * The defining change from the previous implementation is ownership: the sweep belongs to
 * this module, not to an HTTP request. Previously the work lived inside the SSE generator
 * and a module-level AbortController, so closing the browser tab cancelled the check.
 * Here routes only subscribe; the sweep runs to completion regardless of who is watching,
 * and every result is written to SQLite as it lands so a reload shows real progress.
 */

import { DockerClient } from "./docker";
import { fetchRemoteDigest, createTokenCache } from "./registry";
import { parseImageRef, checkability } from "./image-ref";
import { Broadcast } from "./broadcast";
import { loadDockerCredentials } from "./docker-credentials";
import { UpdateCheckStore } from "../stores/update-check-store";
import type { UpdateCheckRunRow, ImageUpdateStateRow } from "../db/schema";

/** Concurrent registry lookups. Bounds local sockets and isolates one slow registry. */
const CONCURRENCY = 6;

/** Per-image ceiling, so one unresponsive registry cannot wedge the sweep. */
const IMAGE_TIMEOUT_MS = 20_000;

/** Whole-run ceiling. A sweep past this is stuck, not slow. */
const RUN_TIMEOUT_MS = 10 * 60_000;

/** How long a completed run stays fresh enough to skip an automatic re-check. */
const DEFAULT_STALENESS_MS = 3 * 60 * 60_000;

export type CheckerEvent =
  | { type: "started";  run: UpdateCheckRunRow }
  | { type: "result";   result: ImageUpdateStateRow }
  | { type: "progress"; completed: number; total: number; updatesFound: number }
  | { type: "finished"; run: UpdateCheckRunRow }
  | { type: "heartbeat" };

export type StartOutcome =
  | { started: true;  runId: number }
  | { started: false; reason: "running";  run: UpdateCheckRunRow }
  | { started: false; reason: "recent";   run: UpdateCheckRunRow }
  | { started: false; reason: "no-docker"; error: string };

interface Target { stack: string; image: string }

class UpdateChecker {
  private readonly bus = new Broadcast<CheckerEvent>();
  private active: { runId: number; abort: AbortController } | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  /**
   * Serialises start() calls.
   *
   * Single-flight cannot be enforced by checking `active` alone: start() awaits the run
   * lookup, discovery and the insert before assigning it, so two concurrent callers both
   * observe null and both launch a sweep, with only the second one tracked. Chaining the
   * calls closes that window without holding a lock across the sweep itself.
   */
  private startChain: Promise<unknown> = Promise.resolve();

  /** True while a sweep is in flight in this process. */
  get running(): boolean {
    return this.active !== null;
  }

  get currentRunId(): number | null {
    return this.active?.runId ?? null;
  }

  /**
   * Reconcile persisted state with reality at startup.
   *
   * A run is owned by the process that started it, so anything still marked `running` in
   * the table belongs to a process that died. Left alone it would block every future
   * sweep, since single-flight consults the database rather than only memory.
   */
  async recoverOnBoot(): Promise<number> {
    return UpdateCheckStore.markOrphansInterrupted();
  }

  subscribe(signal?: AbortSignal): AsyncGenerator<CheckerEvent> {
    return this.bus.subscribe(signal);
  }

  /** Register a subscriber now, so a caller can read a snapshot without missing events. */
  attach(signal?: AbortSignal) {
    return this.bus.attach(signal);
  }

  /**
   * Begin a sweep.
   *
   * `auto` runs are skipped when a recent one exists, so several dashboard tabs opening
   * together do not each trigger work. `force` cancels an in-flight sweep and starts over
   * in one step — the UI would otherwise have to call cancel and start separately, and
   * another tab could slip a run in between.
   */
  async start(opts: { auto?: boolean; force?: boolean; stalenessMs?: number; stack?: string } = {}): Promise<StartOutcome> {
    const result = this.startChain.then(() => this.beginStart(opts));
    // Swallow on the chain only: the caller still sees the rejection through `result`.
    this.startChain = result.catch(() => undefined);
    return result;
  }

  private async beginStart(
    opts: { auto?: boolean; force?: boolean; stalenessMs?: number; stack?: string },
  ): Promise<StartOutcome> {
    const { auto = false, force = false, stalenessMs = DEFAULT_STALENESS_MS, stack } = opts;

    if (this.active) {
      if (!force) {
        // A non-force request must never cancel. Falling through when the row could not
        // be read would do exactly that, killing a live sweep because of a lookup miss.
        const run = await UpdateCheckStore.findRun(this.active.runId);
        return run
          ? { started: false, reason: "running", run }
          : { started: false, reason: "running", run: await this.syntheticRun(this.active.runId) };
      }
      await this.cancel();
    }

    if (auto && !stack) {
      const last = await UpdateCheckStore.lastFullRun();
      if (last?.finishedAt && Date.now() - last.finishedAt.getTime() < stalenessMs) {
        return { started: false, reason: "recent", run: last };
      }
    }

    const discovered = await this.discover();
    if (!discovered.ok) return { started: false, reason: "no-docker", error: discovered.error };

    // A scoped check narrows the target list; everything downstream is identical, so a
    // single stack cannot drift from how a full sweep behaves.
    const targets = { data: stack ? discovered.data.filter(t => t.stack === stack) : discovered.data };

    const run = await UpdateCheckStore.createRun(auto, targets.data.length, stack ?? null);
    const abort = new AbortController();
    this.active = { runId: run.id, abort };

    this.bus.publish({ type: "started", run });
    this.startHeartbeat();

    // Deliberately not awaited: start() answers "did a sweep begin", and the caller must
    // not be held open for the minutes the sweep may take.
    // run() owns finalisation, so no status is written here: a catch at this level ran
    // after run()'s finally, which had already decided there was nothing to publish.
    void this.run(run.id, targets.data, abort, { scoped: Boolean(stack) })
      .finally(() => {
        // Only clear state still belonging to this run. A force-restart cancels the old
        // sweep and starts a new one, and the old promise settles afterwards — clearing
        // unconditionally would untrack the live run, leaving `running` false while a
        // sweep continues and making cancel() a no-op.
        if (this.active?.runId === run.id) {
          this.active = null;
          this.stopHeartbeat();
        }
      });

    return { started: true, runId: run.id };
  }

  /**
   * A stand-in row for a run whose record cannot be read.
   *
   * Only reached if the row vanished under us; the caller needs *something* describing the
   * run in progress, and reporting "running" with placeholder counts is truer than
   * reporting that nothing is happening.
   */
  private async syntheticRun(runId: number): Promise<UpdateCheckRunRow> {
    return {
      id: runId, status: "running", total: 0, completed: 0, updatesFound: 0,
      getFallbacks: 0, auto: false, scopeStack: null, error: null,
      startedAt: new Date(), progressAt: new Date(), finishedAt: null,
    };
  }

  /** Cancel the in-flight sweep, if any. Results already written are kept. */
  async cancel(): Promise<boolean> {
    if (!this.active) return false;
    const { runId, abort } = this.active;
    // Record the reason before aborting: run()'s finaliser only supplies a status when
    // the row is still `running`, so this is what distinguishes a cancellation from a
    // watchdog timeout. The terminal event is published there, not here — publishing in
    // both places gave subscribers two `finished` events for one run.
    await UpdateCheckStore.finishRun(runId, "cancelled");
    abort.abort();
    this.active = null;
    this.stopHeartbeat();
    return true;
  }

  /** Every (stack, image) pair worth checking, deduplicated. */
  private async discover(): Promise<{ ok: true; data: Target[] } | { ok: false; error: string }> {
    const result = await DockerClient.listContainers();
    if (!result.ok) return { ok: false, error: result.error };

    const seen = new Set<string>();
    const targets: Target[] = [];
    for (const c of result.data) {
      const stack = c.Labels?.["com.docker.compose.project"]?.trim()
        || c.Names[0]?.replace(/^\//, "")
        || c.Id.slice(0, 12);
      const image = c.Image?.trim();
      if (!stack || !image) continue;

      const key = `${stack} ${image}`;
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push({ stack, image });
    }
    return { ok: true, data: targets };
  }

  /** Drive the sweep: a fixed pool of workers over the target list. */
  private async run(
    runId: number,
    targets: Target[],
    controller: AbortController,
    opts: { scoped: boolean } = { scoped: false },
  ): Promise<void> {
    const signal = controller.signal;
    const tokenCache = createTokenCache();
    // Read once per sweep: a login during a run should not change its behaviour midway.
    const credentials = await loadDockerCredentials();
    // Abort this run's own controller, not whatever happens to be active: after a
    // force-restart those differ, and the old watchdog would kill the new sweep.
    let timedOut = false;
    const watchdog = setTimeout(() => {
      if (!signal.aborted) { timedOut = true; controller.abort(); }
    }, RUN_TIMEOUT_MS);

    let completed = 0, updatesFound = 0, getFallbacks = 0, cursor = 0;

    const worker = async (): Promise<void> => {
      while (!signal.aborted) {
        const index = cursor++;
        const target = targets[index];
        if (!target) return;

        const outcome = await this.checkOne(target, tokenCache, signal, credentials);
        if (signal.aborted) return;

        if (outcome.hasUpdate)      updatesFound++;
        if (outcome.usedGetFallback) getFallbacks++;

        // Publishing the stored row rather than the raw outcome means subscribers and a
        // page reload see byte-identical data.
        const row = await UpdateCheckStore.putResult(runId, { ...target, ...outcome });
        completed++;

        await UpdateCheckStore.recordProgress(runId, completed, updatesFound, getFallbacks);

        if (row) this.bus.publish({ type: "result", result: row });
        this.bus.publish({ type: "progress", completed, total: targets.length, updatesFound });
      }
    };

    // One finalisation path for every ending. Previously a watchdog abort or a thrown
    // error left the row `running` and published nothing: the sweep looked permanently in
    // progress, single-flight refused every later run, and subscribers waited forever for
    // a terminal event that never came.
    let status: "done" | "failed" | "cancelled" = "done";
    let error: string | null = null;

    try {
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, worker));

      if (signal.aborted) {
        status = timedOut ? "failed" : "cancelled";
        if (timedOut) error = `Timed out after ${Math.round(RUN_TIMEOUT_MS / 60_000)} minutes`;
      } else {
        // Only a full sweep knows the complete set of images; pruning after a scoped check
        // would delete every other stack's results. An empty target list is also not
        // evidence that the host has no containers — a daemon hiccup returns one — and
        // treating it as such would wipe every stored result.
        if (!opts.scoped && targets.length > 0) await UpdateCheckStore.retainOnly(targets);
      }
    } catch (err) {
      status = "failed";
      error  = err instanceof Error ? err.message : String(err);
    } finally {
      clearTimeout(watchdog);
      // cancel() writes `cancelled` before aborting, so a row already finalised keeps the
      // reason it recorded; this only settles runs that reached the end still `running`.
      const current = await UpdateCheckStore.findRun(runId);
      if (current?.status === "running") {
        await UpdateCheckStore.finishRun(runId, status, error);
      }
      const finalRun = await UpdateCheckStore.findRun(runId);
      if (finalRun) this.bus.publish({ type: "finished", run: finalRun });
    }
  }

  /** Resolve one image: local digest from Docker, remote digest from its registry. */
  private async checkOne(
    target: Target,
    tokenCache: ReturnType<typeof createTokenCache>,
    signal: AbortSignal,
    credentials?: Awaited<ReturnType<typeof loadDockerCredentials>>,
  ) {
    const ref = parseImageRef(target.image);
    if (!ref) {
      return { error: "Unparseable image reference", hasUpdate: false, usedGetFallback: false };
    }

    const { checkable, reason } = checkability(ref);
    if (!checkable) {
      return { skippedReason: reason, hasUpdate: false, usedGetFallback: false };
    }

    const localDigest = await DockerClient.getLocalDigest(target.image);
    if (!localDigest) {
      // No RepoDigests means the image never came from a registry — typically built
      // locally. There is nothing to compare against, which is not a failure.
      return { skippedReason: "built locally (no registry digest)", hasUpdate: false, usedGetFallback: false };
    }
    if (signal.aborted) return { hasUpdate: false, usedGetFallback: false };

    const remote = await fetchRemoteDigest(target.image, {
      tokenCache,
      timeoutMs: IMAGE_TIMEOUT_MS,
      signal,
      ...(credentials ? { credentials } : {}),
    });
    if (remote.error) {
      return { localDigest, error: remote.error, hasUpdate: false, usedGetFallback: remote.usedGetFallback };
    }

    return {
      localDigest,
      remoteDigest: remote.digest,
      hasUpdate: remote.digest !== null && remote.digest !== localDigest,
      usedGetFallback: remote.usedGetFallback,
    };
  }

  /** Keeps idle SSE connections alive; proxies drop silent streams. */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeat = setInterval(() => this.bus.publish({ type: "heartbeat" }), 20_000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }
}

/** Process-wide singleton — the sweep outlives any one request. */
export const updateChecker = new UpdateChecker();
