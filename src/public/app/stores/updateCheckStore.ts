import { create } from "zustand";
import { api } from "../lib/api";

/**
 * Client view of the background update checker.
 *
 * The sweep no longer belongs to this store — it runs on the server and survives page
 * reloads, so this connects to a stream and reflects state rather than driving it. The
 * connection stays open for the life of the page: detaching it does not stop anything.
 */

export interface ImageUpdateResult {
  stack: string;
  image: string;
  hasUpdate: boolean;
  localDigest: string | null;
  remoteDigest: string | null;
  error: string | null;
  skippedReason: string | null;
  firstSeenAt: string | null;
  checkedAt: string | null;
}

export interface RunSummary {
  id: number;
  status: "running" | "done" | "failed" | "cancelled" | "interrupted";
  total: number;
  completed: number;
  updatesFound: number;
  getFallbacks: number;
  auto: boolean;
  error: string | null;
  startedAt: string | null;
  progressAt: string | null;
  finishedAt: string | null;
}

/** Why a manual check could not start — drives the "cancel the running one?" prompt. */
export interface BlockedStart {
  reason: "running" | "recent";
  run: RunSummary;
}

interface UpdateCheckState {
  connected: boolean;
  running: boolean;
  run: RunSummary | null;
  results: ImageUpdateResult[];
  blocked: BlockedStart | null;
  dialogOpen: boolean;
  purging: boolean;

  connect: () => void;
  disconnect: () => void;
  /** Kick off a sweep. `auto` defers to the staleness gate; `force` restarts a running one. */
  startCheck: (opts?: { auto?: boolean; force?: boolean; stack?: string }) => Promise<void>;
  cancelCheck: () => Promise<void>;
  purge: () => Promise<void>;
  dismissBlocked: () => void;
  openDialog: () => void;
  closeDialog: () => void;

  hasUpdateFor: (stackName: string) => boolean;
  updatesCount: () => number;
  stacksWithUpdates: () => string[];
  progressLabel: () => string | null;
}

// Kept outside Zustand so reconnect bookkeeping does not trigger renders.
let _abort: AbortController | null = null;

/**
 * The update-check endpoints, named rather than indexed.
 *
 * Eden Treaty types a hyphenated path segment awkwardly; naming the shape keeps the calls
 * checked without every access being possibly-undefined.
 */
interface UpdateCheckApi {
  stream: { get: (o: unknown) => Promise<{ data: AsyncIterable<{ data: StreamEvent }> | null; error: unknown }> };
  start:  { post: (b: unknown) => Promise<{ data: unknown; error: unknown }> };
  cancel: { post: (b?: unknown) => Promise<unknown> };
  delete: (b?: unknown) => Promise<unknown>;
}

const uc = (): UpdateCheckApi =>
  (api.api.docker as unknown as { "update-check": UpdateCheckApi })["update-check"];

type StreamEvent =
  | { type: "snapshot"; running: boolean; run: RunSummary | null; results: ImageUpdateResult[] }
  | { type: "started";  run: RunSummary }
  | { type: "result";   result: ImageUpdateResult }
  | { type: "progress"; completed: number; total: number; updatesFound: number }
  | { type: "finished"; run: RunSummary }
  | { type: "heartbeat" };

/** Replace by (stack, image) so a re-check updates in place instead of appending. */
function mergeResult(list: ImageUpdateResult[], incoming: ImageUpdateResult): ImageUpdateResult[] {
  const idx = list.findIndex(r => r.stack === incoming.stack && r.image === incoming.image);
  if (idx === -1) return [...list, incoming];
  const next = [...list];
  next[idx] = incoming;
  return next;
}

export const useUpdateCheckStore = create<UpdateCheckState>((set, get) => ({
  connected:  false,
  running:    false,
  run:        null,
  results:    [],
  blocked:    null,
  dialogOpen: false,
  purging:    false,

  connect: () => {
    if (_abort) return;               // already connected
    _abort = new AbortController();
    const { signal } = _abort;

    void (async () => {
      try {
        const { data, error } = await uc().stream.get({ fetch: { signal } });
        if (error || !data) { set({ connected: false }); return; }

        set({ connected: true });

        for await (const event of data) {
          if (signal.aborted) break;
          const msg = event.data;
          if (!msg) continue;

          switch (msg.type) {
            case "snapshot":
              set({ running: msg.running, run: msg.run, results: msg.results ?? [] });
              break;
            case "started":
              // Results are kept rather than cleared: they stay valid until each is
              // rechecked, so badges do not blink off for the length of a sweep.
              set({ running: true, run: msg.run, blocked: null });
              break;
            case "result":
              set(s => ({ results: mergeResult(s.results, msg.result) }));
              break;
            case "progress":
              set(s => ({
                run: s.run ? { ...s.run, completed: msg.completed, total: msg.total, updatesFound: msg.updatesFound } : s.run,
              }));
              break;
            case "finished":
              set({ running: false, run: msg.run });
              break;
            case "heartbeat":
              break;
          }
        }
      } catch {
        // Navigating away aborts the fetch; that is not an error worth surfacing.
      } finally {
        if (!signal.aborted) set({ connected: false });
        _abort = null;
      }
    })();
  },

  disconnect: () => {
    _abort?.abort();
    _abort = null;
    set({ connected: false });
  },

  startCheck: async (opts = {}) => {
    const body = {
      auto: opts.auto ?? false,
      force: opts.force ?? false,
      ...(opts.stack ? { stack: opts.stack } : {}),
    };
    const { data } = await uc().start.post(body);

    const outcome = data as
      | { started: true; runId: number }
      | { started: false; reason: "running" | "recent"; run: RunSummary }
      | { started: false; reason: "no-docker"; error: string }
      | null;

    if (!outcome) return;
    if (outcome.started) { set({ blocked: null }); return; }

    // "recent" only blocks automatic runs, so seeing it here means a manual attempt raced
    // one; either way the UI asks rather than silently doing nothing.
    if (outcome.reason === "running" || outcome.reason === "recent") {
      set({ blocked: { reason: outcome.reason, run: outcome.run } });
    }
  },

  cancelCheck: async () => {
    await uc().cancel.post({});
    set({ blocked: null });
  },

  purge: async () => {
    set({ purging: true });
    try {
      await uc().delete({});
      set({ results: [], run: null });
    } finally {
      set({ purging: false });
    }
  },

  dismissBlocked: () => set({ blocked: null }),
  openDialog:     () => set({ dialogOpen: true }),
  closeDialog:    () => set({ dialogOpen: false }),

  hasUpdateFor: (stackName) => get().results.some(r => r.stack === stackName && r.hasUpdate),

  updatesCount: () => new Set(get().results.filter(r => r.hasUpdate).map(r => r.stack)).size,

  stacksWithUpdates: () => [...new Set(get().results.filter(r => r.hasUpdate).map(r => r.stack))],

  progressLabel: () => {
    const { running, run } = get();
    if (!running || !run) return null;
    return `${run.completed}/${run.total}`;
  },
}));
