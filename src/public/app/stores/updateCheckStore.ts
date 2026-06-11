import { create } from "zustand";
import { api } from "../lib/api";
import type { UpdateCheckMsg } from "../../../plugins/routeUpdateCheck";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ImageUpdateResult {
  stack: string;
  image: string;
  hasUpdate: boolean;
}

// ─── Store ────────────────────────────────────────────────────────────────────

interface UpdateCheckState {
  /** True while the SSE stream is running. */
  checking: boolean;
  /** Stack name currently being inspected (for progress display). */
  checkingStack: string | null;
  /** Image currently being inspected (for progress display). */
  checkingImage: string | null;
  /** All results emitted so far in the current (or last) check. */
  results: ImageUpdateResult[];
  /** ISO timestamp of when the last check finished. */
  lastChecked: string | null;
  /** Whether the updates dialog is open. */
  dialogOpen: boolean;

  startCheck: () => void;
  cancelCheck: () => void;
  openDialog: () => void;
  closeDialog: () => void;

  /** True if the named stack has at least one image with an available update. */
  hasUpdateFor: (stackName: string) => boolean;
  /** Number of stacks that have at least one image with an available update. */
  updatesCount: () => number;
  /** Unique stack names that have at least one update. */
  stacksWithUpdates: () => string[];
}

// AbortController lives outside Zustand state so it doesn't trigger re-renders
let _abort: AbortController | null = null;

export const useUpdateCheckStore = create<UpdateCheckState>((set, get) => ({
  checking:      false,
  checkingStack: null,
  checkingImage: null,
  results:       [],
  lastChecked:   null,
  dialogOpen:    false,

  startCheck: () => {
    // Cancel any previous check
    _abort?.abort();
    _abort = new AbortController();
    const { signal } = _abort;

    set({ checking: true, checkingStack: null, checkingImage: null, results: [] });

    void (async () => {
      try {
        const { data, error } = await (
          (api.api.docker["update-check"].get as (opts: unknown) => unknown)({
            fetch: { signal },
          }) as Promise<{ data: AsyncIterable<{ data: UpdateCheckMsg }> | null; error: unknown }>
        );

        if (error || !data) {
          set({ checking: false });
          return;
        }

        for await (const event of data) {
          if (signal.aborted) break;
          const msg = event.data as UpdateCheckMsg;

          if (msg.checking) {
            set({ checkingStack: msg.checking.stack, checkingImage: msg.checking.image });
          } else if (msg.result) {
            set(s => ({ results: [...s.results, msg.result!] }));
          } else if (msg.done !== undefined) {
            set({ checking: false, checkingStack: null, checkingImage: null, lastChecked: new Date().toISOString() });
          } else if (msg.error) {
            set({ checking: false, checkingStack: null, checkingImage: null });
          }
        }
      } catch {
        if (!signal.aborted) {
          set({ checking: false, checkingStack: null, checkingImage: null });
        }
      }
    })();
  },

  cancelCheck: () => {
    _abort?.abort();
    _abort = null;
    set({ checking: false, checkingStack: null, checkingImage: null });
  },

  openDialog:  () => set({ dialogOpen: true }),
  closeDialog: () => set({ dialogOpen: false }),

  hasUpdateFor: (stackName) =>
    get().results.some(r => r.stack === stackName && r.hasUpdate),

  updatesCount: () => {
    const stacks = new Set(get().results.filter(r => r.hasUpdate).map(r => r.stack));
    return stacks.size;
  },

  stacksWithUpdates: () => {
    const stacks = new Set(get().results.filter(r => r.hasUpdate).map(r => r.stack));
    return [...stacks];
  },
}));
