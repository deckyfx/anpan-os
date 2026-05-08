import { useMemo, useState } from "react";
import { useStacksStore }    from "../stores/stacksStore";
import { useAuthStore }      from "../stores/authStore";

import { TopBar }            from "./home/TopBar";
import { BottomBar }         from "./home/BottomBar";
import { ClockWidget, CalendarWidget, SystemWidget, DiskWidget, NetworkWidget } from "./home/SideWidgets";
import { StackTile }         from "./home/StackTile";
import { StackDetailDialog } from "./home/StackDetailDialog";
import { ContainersDialog }  from "./home/ContainersDialog";
import { NoteDialog }        from "./home/NoteDialog";
import { LogsDialog }        from "./home/LogsDialog";
import { NewStackDialog }    from "./home/NewStackDialog";
import { DeleteStackDialog } from "./home/DeleteStackDialog";

import type { Stack } from "./home/types";

export function HomePage({ username, onLogout, onNavigate }: {
  username: string;
  onLogout: () => void;
  onNavigate: (path: string) => void;
}) {
  const { hasPasskey, registerPasskey } = useAuthStore();

  const {
    stacks, stats, version,
    sortMode, setSortMode,
    dragSrcIdx, dragOverIdx, setDragSrcIdx, setDragOverIdx,
    newStackOpen, setNewStackOpen,
    detailStack, setDetailStack,
    containersStack, setContainersStack,
    noteStack, setNoteStack,
    deleteStack, setDeleteStack,
    logsFor, logText, logsLoading,
    actionBusy,
    initialize, loadStacks, stackAction, handleDrop,
  } = useStacksStore();

  // Lazy-init: starts polling, loads stacks + stats. Runs once per mount.
  useState(() => { initialize(); });

  const [filter, setFilter] = useState("");

  // ── Sorted + filtered stacks ──────────────────────────────────────────────

  const displayedStacks = useMemo<Stack[]>(() => {
    const q = filter.trim().toLowerCase();
    const sorted = sortMode === "name"
      ? [...stacks].sort((a, b) =>
          (a.meta?.title ?? a.name).localeCompare(b.meta?.title ?? b.name))
      : [...stacks].sort((a, b) => {
          const oa = a.meta?.orderNo ?? 9999;
          const ob = b.meta?.orderNo ?? 9999;
          if (oa !== ob) return oa - ob;
          return a.name.localeCompare(b.name);
        });
    if (!q) return sorted;
    return sorted.filter(s =>
      (s.meta?.title ?? s.name).toLowerCase().includes(q) || s.name.toLowerCase().includes(q)
    );
  }, [stacks, sortMode, filter]);

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="h-screen bg-gray-950 text-white flex flex-col overflow-hidden">

      <TopBar
        username={username}
        version={version}
        hasPasskey={hasPasskey}
        onLogout={onLogout}
        onNavigate={onNavigate}
        onAddPasskey={() => registerPasskey("This device")}
      />

      <div className="flex-1 flex overflow-hidden">

        {/* Left panel */}
        <aside className="w-72 border-r border-gray-800 p-4 flex flex-col gap-3 overflow-y-auto shrink-0">
          <ClockWidget />
          <CalendarWidget />
          <SystemWidget stats={stats} />
          <DiskWidget disks={stats?.disks ?? null} />
          <NetworkWidget />
        </aside>

        {/* Main grid */}
        <main className="flex-1 p-6 overflow-y-auto">

          {/* Sort + filter controls */}
          <div className="flex items-center gap-3 mb-5">
            <span className="text-[10px] text-gray-600 font-semibold uppercase tracking-widest">Sort</span>
            <div className="flex gap-1">
              {(["custom", "name"] as const).map(mode => (
                <button
                  key={mode}
                  onClick={() => setSortMode(mode)}
                  className={`text-xs px-3 py-1 rounded-full transition-colors
                    ${sortMode === mode
                      ? "bg-amber-500 text-black font-medium"
                      : "text-gray-500 hover:text-gray-200 hover:bg-gray-800"
                    }`}
                >
                  {mode === "custom" ? "Custom" : "A → Z"}
                </button>
              ))}
            </div>
            {sortMode === "custom" && (
              <span className="text-[10px] text-gray-700">drag tiles to reorder</span>
            )}
            <div className="ml-auto relative">
              <input
                type="text"
                value={filter}
                onChange={e => setFilter(e.target.value)}
                placeholder="Filter…"
                className="w-40 bg-gray-800 border border-gray-700 rounded-lg px-3 py-1 pr-7 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-amber-500"
              />
              {filter && (
                <button
                  onClick={() => setFilter("")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-white transition-colors"
                >
                  ✕
                </button>
              )}
            </div>
          </div>

          <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-4">

            {/* Files tile */}
            <div
              onClick={() => onNavigate("/files")}
              className="bg-gray-900 border border-dashed border-gray-700 rounded-2xl p-5 flex flex-col items-center gap-3 cursor-pointer hover:border-amber-500/50 hover:bg-gray-800/50 hover:scale-[1.02] transition-all select-none"
            >
              <div className="w-16 h-16 rounded-2xl bg-gray-800 border border-gray-700 flex items-center justify-center text-4xl">
                📁
              </div>
              <div className="text-center">
                <p className="text-sm text-gray-200 font-medium">Files</p>
                <p className="text-xs text-gray-600 mt-0.5">File manager</p>
              </div>
            </div>

            {/* New Stack tile */}
            <div
              onClick={() => setNewStackOpen(true)}
              className="bg-gray-900 border border-dashed border-gray-700 rounded-2xl p-5 flex flex-col items-center gap-3 cursor-pointer hover:border-amber-500/50 hover:bg-gray-800/50 hover:scale-[1.02] transition-all select-none"
            >
              <div className="w-16 h-16 rounded-2xl bg-gray-800 border border-gray-700 flex items-center justify-center text-4xl font-light text-amber-400">
                +
              </div>
              <div className="text-center">
                <p className="text-sm text-gray-200 font-medium">New Stack</p>
                <p className="text-xs text-gray-600 mt-0.5">Docker Compose</p>
              </div>
            </div>

            {displayedStacks.map((s, i) => (
              <StackTile
                key={s.name}
                stack={s}
                actionLoading={actionBusy === s.name}
                onAction={(action) => void stackAction(s, action)}
                dragEnabled={sortMode === "custom"}
                dragging={dragSrcIdx === i}
                dragOver={dragOverIdx === i && dragSrcIdx !== i}
                onDragStart={() => setDragSrcIdx(i)}
                onDragOver={(e) => { e.preventDefault(); setDragOverIdx(i); }}
                onDrop={() => void handleDrop(i, displayedStacks)}
                onDragEnd={() => { setDragSrcIdx(null); setDragOverIdx(null); }}
              />
            ))}
          </div>
        </main>
      </div>

      <BottomBar stacks={stacks} />

      {/* ── Dialogs ── */}
      <NewStackDialog
        open={newStackOpen}
        onClose={() => setNewStackOpen(false)}
        onInstalled={() => void loadStacks()}
      />

      {detailStack && (
        <StackDetailDialog
          stack={detailStack}
          open={detailStack !== null}
          onClose={() => setDetailStack(null)}
          onSaved={() => { void loadStacks(); }}
        />
      )}

      <ContainersDialog
        stack={containersStack}
        open={containersStack !== null}
        onClose={() => setContainersStack(null)}
      />

      <NoteDialog
        stack={noteStack}
        open={noteStack !== null}
        onClose={() => setNoteStack(null)}
        onSaved={() => { void loadStacks(); }}
      />

      <LogsDialog
        open={logsFor !== null}
        stack={logsFor}
        logs={logText}
        loading={logsLoading}
        onClose={() => useStacksStore.setState({ logsFor: null })}
      />

      <DeleteStackDialog
        stack={deleteStack}
        open={deleteStack !== null}
        onClose={() => setDeleteStack(null)}
        onDeleted={() => { void loadStacks(); }}
      />
    </div>
  );
}
