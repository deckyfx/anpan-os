import { create } from "zustand";
import { api } from "../lib/api";
import type { Stack, SystemStats, SortMode, StackAction } from "../pages/home/types";
import { useToastStore } from "./toastStore";
import { useFileStore } from "./fileStore";

interface StacksState {
  stacks:  Stack[];
  stats:   SystemStats | null;
  version: string;

  sortMode:   SortMode;
  dragSrcIdx: number | null;
  dragOverIdx: number | null;

  newStackOpen:    boolean;
  detailStack:     Stack | null;
  noteStack:       Stack | null;
  deleteStack:     Stack | null;
  logsFor: Stack | null;
  guidedEditStack:   Stack | null;
  pullStack:         Stack | null;
  migrateStack:      Stack | null;
  installLogStack:   Stack | null;
  installLogText:    string;
  installLogLoading: boolean;

  actionBusy: string | null;

  /** Populated when browse-mounts returns >1 paths; null hides the picker. */
  mountPickerStack: Stack | null;
  mountPickerPaths: string[];

  initialized: boolean;

  initialize:      () => void;
  loadStacks:      () => Promise<void>;
  loadStats:       () => Promise<void>;
  setSortMode:     (mode: SortMode) => void;
  setDragSrcIdx:   (idx: number | null) => void;
  setDragOverIdx:  (idx: number | null) => void;
  setNewStackOpen: (open: boolean) => void;
  setDetailStack:  (stack: Stack | null) => void;
  setNoteStack:    (stack: Stack | null) => void;
  setDeleteStack:  (stack: Stack | null) => void;
  setGuidedEditStack: (stack: Stack | null) => void;
  setPullStack:       (stack: Stack | null) => void;
  setMigrateStack:    (stack: Stack | null) => void;
  setMountPicker:     (stack: Stack | null, paths?: string[]) => void;
  stackAction:     (stack: Stack, action: StackAction, navigate?: (path: string) => void) => Promise<void>;
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
  noteStack:    null,
  deleteStack:  null,
  logsFor: null,
  guidedEditStack:   null,
  pullStack:         null,
  migrateStack:      null,
  installLogStack:   null,
  installLogText:    "",
  installLogLoading: false,
  actionBusy:        null,
  mountPickerStack:  null,
  mountPickerPaths:  [],
  initialized:       false,

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
    try {
      const { data } = await api.api.docker.stacks.get();
      if (data) set({ stacks: data as Stack[] });
    } catch { /* network error — keep last known stacks, retry on next poll */ }
  },

  loadStats: async () => {
    try {
      const { data } = await api.api.system.stats.get();
      if (data) set({ stats: data as SystemStats });
    } catch { /* network error — keep last known stats */ }
  },

  setSortMode:     (sortMode) => set({ sortMode }),
  setDragSrcIdx:   (dragSrcIdx) => set({ dragSrcIdx }),
  setDragOverIdx:  (dragOverIdx) => set({ dragOverIdx }),
  setNewStackOpen: (newStackOpen) => set({ newStackOpen }),
  setDetailStack:  (detailStack) => set({ detailStack }),
  setNoteStack:    (noteStack) => set({ noteStack }),
  setDeleteStack:  (deleteStack) => set({ deleteStack }),
  setGuidedEditStack: (guidedEditStack) => set({ guidedEditStack }),
  setPullStack:       (pullStack)       => set({ pullStack }),
  setMigrateStack:    (migrateStack)    => set({ migrateStack }),
  setMountPicker:     (stack, paths = []) => set({ mountPickerStack: stack, mountPickerPaths: paths }),

  stackAction: async (stack, action, navigate) => {
    if (action === "logs") {
      set({ logsFor: stack });
      return;
    }
    if (action === "note")             { set({ noteStack: stack });       return; }
    if (action === "detail")           { set({ detailStack: stack });     return; }
    if (action === "delete")           { set({ deleteStack: stack });     return; }
    if (action === "guided-edit")      { set({ guidedEditStack: stack }); return; }
    if (action === "pull-update")      { set({ pullStack: stack });       return; }
    if (action === "migrate-casaos")   { set({ migrateStack: stack });    return; }

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

    if (action === "browse-mounts") {
      set({ actionBusy: stack.name });
      try {
        const { data, error } = await api.api.docker.stacks({ name: stack.name }).binds.get();
        if (error || !data) {
          useToastStore.getState().push("Failed to fetch mounted volumes", "error");
          return;
        }
        const paths = (data as { paths: string[] }).paths ?? [];
        if (paths.length === 0) {
          useToastStore.getState().push("No mounted volumes found for this stack", "info");
          return;
        }
        if (paths.length === 1 && navigate) {
          const path = paths[0]!;
          useFileStore.getState().setPendingPath(path);
          navigate("/files");
          return;
        }
        // Multiple paths — open picker
        set({ mountPickerStack: stack, mountPickerPaths: paths });
      } finally {
        set({ actionBusy: null });
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
