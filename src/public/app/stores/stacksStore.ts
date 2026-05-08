import { create } from "zustand";
import { api } from "../lib/api";
import type { Stack, SystemStats, SortMode, StackAction } from "../pages/home/types";
import { useToastStore } from "./toastStore";

interface StacksState {
  stacks:  Stack[];
  stats:   SystemStats | null;
  version: string;

  sortMode:   SortMode;
  dragSrcIdx: number | null;
  dragOverIdx: number | null;

  newStackOpen:    boolean;
  detailStack:     Stack | null;
  containersStack: Stack | null;
  noteStack:       Stack | null;
  deleteStack:     Stack | null;
  logsFor:         Stack | null;
  logText:         string;
  logsLoading:     boolean;
  editStack:         Stack | null;
  pullStack:         Stack | null;
  installLogStack:   Stack | null;
  installLogText:    string;
  installLogLoading: boolean;

  actionBusy: string | null;

  initialized: boolean;

  initialize:      () => void;
  loadStacks:      () => Promise<void>;
  loadStats:       () => Promise<void>;
  setSortMode:     (mode: SortMode) => void;
  setDragSrcIdx:   (idx: number | null) => void;
  setDragOverIdx:  (idx: number | null) => void;
  setNewStackOpen: (open: boolean) => void;
  setDetailStack:  (stack: Stack | null) => void;
  setContainersStack: (stack: Stack | null) => void;
  setNoteStack:    (stack: Stack | null) => void;
  setDeleteStack:  (stack: Stack | null) => void;
  setEditStack:    (stack: Stack | null) => void;
  setPullStack:    (stack: Stack | null) => void;
  stackAction:     (stack: Stack, action: StackAction) => Promise<void>;
  handleDrop:      (dropIdx: number, displayedStacks: Stack[]) => Promise<void>;
}

const POLL_INTERVAL = 30_000;

export const useStacksStore = create<StacksState>((set, get) => ({
  stacks:       [],
  stats:        null,
  version:      "…",
  sortMode:     "custom",
  dragSrcIdx:   null,
  dragOverIdx:  null,
  newStackOpen: false,
  detailStack:  null,
  containersStack: null,
  noteStack:    null,
  deleteStack:  null,
  logsFor:      null,
  logText:      "",
  logsLoading:  false,
  editStack:         null,
  pullStack:         null,
  installLogStack:   null,
  installLogText:    "",
  installLogLoading: false,
  actionBusy:   null,
  initialized:  false,

  initialize: () => {
    if (get().initialized) return;
    set({ initialized: true });

    void get().loadStacks();
    void get().loadStats();

    api.api.system.info.get()
      .then(({ data }) => {
        if (data && typeof data === "object" && "version" in data)
          set({ version: String((data as { version: unknown }).version) });
      })
      .catch(() => {});

    setInterval(() => {
      void get().loadStacks();
      void get().loadStats();
    }, POLL_INTERVAL);
  },

  loadStacks: async () => {
    const { data } = await api.api.docker.stacks.get();
    if (data) set({ stacks: data as Stack[] });
  },

  loadStats: async () => {
    const { data } = await api.api.system.stats.get();
    if (data) set({ stats: data as SystemStats });
  },

  setSortMode:     (sortMode) => set({ sortMode }),
  setDragSrcIdx:   (dragSrcIdx) => set({ dragSrcIdx }),
  setDragOverIdx:  (dragOverIdx) => set({ dragOverIdx }),
  setNewStackOpen: (newStackOpen) => set({ newStackOpen }),
  setDetailStack:  (detailStack) => set({ detailStack }),
  setContainersStack: (containersStack) => set({ containersStack }),
  setNoteStack:    (noteStack) => set({ noteStack }),
  setDeleteStack:  (deleteStack) => set({ deleteStack }),
  setEditStack:    (editStack) => set({ editStack }),
  setPullStack:    (pullStack) => set({ pullStack }),

  stackAction: async (stack, action) => {
    if (action === "logs") {
      set({ logsFor: stack, logText: "", logsLoading: true });
      try {
        const target = stack.services.find((s) => s.state === "running") ?? stack.services[0];
        if (!target) { set({ logText: "(no services)" }); return; }
        const { data } = await api.api.docker.containers({ id: target.id }).logs.get({ query: { tail: "100" } });
        const d = data as { logs?: string; error?: string } | null;
        set({ logText: d?.logs ?? d?.error ?? "(empty)" });
      } finally {
        set({ logsLoading: false });
      }
      return;
    }
    if (action === "note")             { set({ noteStack: stack });       return; }
    if (action === "detail")           { set({ detailStack: stack });     return; }
    if (action === "containers")       { set({ containersStack: stack }); return; }
    if (action === "delete")           { set({ deleteStack: stack });     return; }
    if (action === "edit-compose")     { set({ editStack: stack });       return; }
    if (action === "pull-update")      { set({ pullStack: stack });       return; }

    if (action === "view-install-log") {
      set({ installLogStack: stack, installLogText: "", installLogLoading: true });
      try {
        const { data } = await api.api.compose.stacks({ name: stack.name })["install-log"].get();
        const d = data as { log?: string; error?: string } | null;
        set({ installLogText: d?.log ?? d?.error ?? "(empty)" });
      } finally {
        set({ installLogLoading: false });
      }
      return;
    }

    if (action === "download-compose") {
      const { data, error } = await api.api.compose.stacks({ name: stack.name }).file.get();
      if (error) {
        alert((error.value as { error?: string })?.error ?? "Compose file not found for this stack.");
        return;
      }
      const blob = new Blob([data as unknown as string], { type: "text/yaml" });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement("a");
      a.href     = url;
      a.download = `${stack.name}-docker-compose.yml`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      return;
    }
    if (action === "casaos-import") {
      set({ actionBusy: stack.name });
      try {
        const { error } = await api.api.casaos.import({ id: stack.name }).post();
        if (!error) {
          await get().loadStacks();
          useToastStore.getState().push("Imported from CasaOS", "success");
        }
      } finally {
        set({ actionBusy: null });
      }
      return;
    }

    set({ actionBusy: stack.name });
    try {
      await Promise.all(
        stack.services.map((s) => {
          const c = api.api.docker.containers({ id: s.id });
          if (action === "start")   return c.start.post();
          if (action === "stop")    return c.stop.post();
          if (action === "restart") return c.restart.post();
          return Promise.resolve();
        })
      );
      await get().loadStacks();
      const label = action === "start" ? "started" : action === "stop" ? "stopped" : "restarted";
      useToastStore.getState().push(`Stack ${label}`, "success");
    } catch (err) {
      useToastStore.getState().push(
        err instanceof Error ? err.message : `Failed to ${action} stack`,
        "error",
      );
    } finally {
      set({ actionBusy: null });
    }
  },

  handleDrop: async (dropIdx, displayedStacks) => {
    const { dragSrcIdx } = get();
    if (dragSrcIdx === null || dragSrcIdx === dropIdx) {
      set({ dragSrcIdx: null, dragOverIdx: null });
      return;
    }
    const newOrder = [...displayedStacks];
    const moved = newOrder.splice(dragSrcIdx, 1)[0];
    if (!moved) { set({ dragSrcIdx: null, dragOverIdx: null }); return; }
    newOrder.splice(dropIdx, 0, moved);

    // Optimistic update
    set((state) => {
      const nameOrder = new Map(newOrder.map((s, i) => [s.name, i]));
      return {
        stacks:     [...state.stacks].sort((a, b) => (nameOrder.get(a.name) ?? 999) - (nameOrder.get(b.name) ?? 999)),
        dragSrcIdx:  null,
        dragOverIdx: null,
      };
    });

    await Promise.all(
      newOrder.map((s, i) => api.api.docker.stacks({ name: s.name }).patch({ orderNo: i }))
    );
    await get().loadStacks();
  },
}));
