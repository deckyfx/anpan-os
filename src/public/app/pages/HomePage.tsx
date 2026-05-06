import { useCallback, useEffect, useMemo, useState } from "react";

import { TopBar }            from "./home/TopBar";
import { BottomBar }         from "./home/BottomBar";
import { ClockWidget, CalendarWidget, SystemWidget, NetworkWidget } from "./home/SideWidgets";
import { StackTile }         from "./home/StackTile";
import { StackDetailDialog } from "./home/StackDetailDialog";
import { ContainersDialog }  from "./home/ContainersDialog";
import { NoteDialog }        from "./home/NoteDialog";
import { LogsDialog }        from "./home/LogsDialog";
import { NewStackDialog }    from "./home/NewStackDialog";
import { DeleteStackDialog } from "./home/DeleteStackDialog";

import type { Stack, SystemStats, StackAction, SortMode } from "./home/types";

export function HomePage({ username, onLogout, onNavigate }: {
  username: string;
  onLogout: () => void;
  onNavigate: (path: string) => void;
}) {
  const [stacks,         setStacks]         = useState<Stack[]>([]);
  const [stats,          setStats]          = useState<SystemStats | null>(null);
  const [version,        setVersion]        = useState("…");
  const [sortMode,       setSortMode]       = useState<SortMode>("custom");
  const [newStackOpen,   setNewStackOpen]   = useState(false);
  const [logsFor,        setLogsFor]        = useState<Stack | null>(null);
  const [logText,        setLogText]        = useState("");
  const [logsLoading,    setLogsLoading]    = useState(false);
  const [actionBusy,     setActionBusy]     = useState<string | null>(null);
  const [detailStack,    setDetailStack]    = useState<Stack | null>(null);
  const [containersStack, setContainersStack] = useState<Stack | null>(null);
  const [noteStack,      setNoteStack]      = useState<Stack | null>(null);
  const [deleteStack,    setDeleteStack]    = useState<Stack | null>(null);
  // Drag state
  const [dragSrcIdx,     setDragSrcIdx]     = useState<number | null>(null);
  const [dragOverIdx,    setDragOverIdx]    = useState<number | null>(null);

  // ── Data loading ──────────────────────────────────────────────────────────

  const loadStacks = useCallback(async () => {
    const res = await fetch("/api/docker/stacks");
    if (!res.ok) return;
    setStacks(await res.json() as Stack[]);
  }, []);

  const loadStats = useCallback(async () => {
    const res = await fetch("/api/system/stats");
    if (!res.ok) return;
    setStats(await res.json() as SystemStats);
  }, []);

  useEffect(() => {
    void loadStacks();
    void loadStats();
    fetch("/api/system/info")
      .then((r) => r.json())
      .then((d: unknown) => {
        if (d && typeof d === "object" && "version" in d)
          setVersion(String((d as { version: unknown }).version));
      })
      .catch(() => {});
    const id = setInterval(() => { void loadStacks(); void loadStats(); }, 30_000);
    return () => clearInterval(id);
  }, [loadStacks, loadStats]);

  // ── Sorted stacks ─────────────────────────────────────────────────────────

  const displayedStacks = useMemo<Stack[]>(() => {
    if (sortMode === "name") {
      return [...stacks].sort((a, b) =>
        (a.meta?.title ?? a.name).localeCompare(b.meta?.title ?? b.name)
      );
    }
    return [...stacks].sort((a, b) => {
      const oa = a.meta?.orderNo ?? 9999;
      const ob = b.meta?.orderNo ?? 9999;
      if (oa !== ob) return oa - ob;
      return a.name.localeCompare(b.name);
    });
  }, [stacks, sortMode]);

  // ── Stack actions ─────────────────────────────────────────────────────────

  const openLogs = async (stack: Stack) => {
    setLogsFor(stack);
    setLogText("");
    setLogsLoading(true);
    try {
      const target = stack.services.find((s) => s.state === "running") ?? stack.services[0];
      if (!target) { setLogText("(no services)"); return; }
      const res  = await fetch(`/api/docker/containers/${target.id}/logs?tail=100`);
      const data = await res.json() as { logs?: string; error?: string };
      setLogText(data.logs ?? data.error ?? "(empty)");
    } finally {
      setLogsLoading(false);
    }
  };

  const downloadCompose = async (stack: Stack) => {
    const res = await fetch(`/api/compose/stacks/${encodeURIComponent(stack.name)}/file`);
    if (!res.ok) {
      const d = await res.json().catch(() => ({})) as { error?: string };
      alert(d.error ?? "Compose file not found for this stack.");
      return;
    }
    const blob = await res.blob();
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href     = url;
    a.download = `${stack.name}-docker-compose.yml`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const importCasaos = async (stack: Stack) => {
    setActionBusy(stack.name);
    try {
      const res = await fetch(`/api/casaos/import/${encodeURIComponent(stack.name)}`, { method: "POST" });
      if (res.ok) await loadStacks();
    } finally {
      setActionBusy(null);
    }
  };

  const stackAction = async (stack: Stack, action: StackAction) => {
    if (action === "logs")             { await openLogs(stack);           return; }
    if (action === "note")             { setNoteStack(stack);             return; }
    if (action === "detail")           { setDetailStack(stack);           return; }
    if (action === "containers")       { setContainersStack(stack);       return; }
    if (action === "download-compose") { await downloadCompose(stack);    return; }
    if (action === "casaos-import")    { await importCasaos(stack);       return; }
    if (action === "delete")           { setDeleteStack(stack);           return; }
    setActionBusy(stack.name);
    try {
      await Promise.all(
        stack.services.map((s) => fetch(`/api/docker/containers/${s.id}/${action}`, { method: "POST" }))
      );
      await loadStacks();
    } finally {
      setActionBusy(null);
    }
  };

  // ── Drag-to-reorder ───────────────────────────────────────────────────────

  const handleDrop = async (dropIdx: number) => {
    if (dragSrcIdx === null || dragSrcIdx === dropIdx) {
      setDragSrcIdx(null);
      setDragOverIdx(null);
      return;
    }
    const newOrder = [...displayedStacks];
    const moved = newOrder.splice(dragSrcIdx, 1)[0];
    if (!moved) { setDragSrcIdx(null); setDragOverIdx(null); return; }
    newOrder.splice(dropIdx, 0, moved);

    // Optimistic update
    setStacks(prev => {
      const nameOrder = new Map(newOrder.map((s, i) => [s.name, i]));
      return [...prev].sort((a, b) => (nameOrder.get(a.name) ?? 999) - (nameOrder.get(b.name) ?? 999));
    });
    setDragSrcIdx(null);
    setDragOverIdx(null);

    await Promise.all(
      newOrder.map((s, i) =>
        fetch(`/api/docker/stacks/${encodeURIComponent(s.name)}`, {
          method:  "PATCH",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({ orderNo: i }),
        })
      )
    );
    await loadStacks();
  };

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="h-screen bg-gray-950 text-white flex flex-col overflow-hidden">

      <TopBar username={username} version={version} onLogout={onLogout} />

      <div className="flex-1 flex overflow-hidden">

        {/* Left panel */}
        <aside className="w-60 border-r border-gray-800 p-4 flex flex-col gap-3 overflow-y-auto shrink-0">
          <ClockWidget />
          <CalendarWidget />
          <SystemWidget stats={stats} />
          <NetworkWidget />
        </aside>

        {/* Main grid */}
        <main className="flex-1 p-6 overflow-y-auto">

          {/* Sort controls */}
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
                onDrop={() => void handleDrop(i)}
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
        onClose={() => setLogsFor(null)}
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
