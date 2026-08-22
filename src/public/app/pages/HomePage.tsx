import { useEffect, useMemo, useState } from "react";
import { useStacksStore }   from "../stores/stacksStore";
import { useAuthStore }     from "../stores/authStore";
import { useBookmarkStore } from "../stores/bookmarkStore";
import { useToastStore }    from "../stores/toastStore";
import { useUpdateCheckStore } from "../stores/updateCheckStore";

import { TopBar }            from "./home/TopBar";
import { BottomBar }         from "./home/BottomBar";
import { ClockWidget, CalendarWidget, SystemWidget, DiskWidget, NetworkWidget } from "./home/SideWidgets";
import { DockerSummaryBar }  from "../components/DockerSummaryBar";
import { StackTile }         from "./home/StackTile";
import { BookmarkTile }      from "./home/BookmarkTile";
import { StackDetailDialog } from "./home/StackDetailDialog";
import { NoteDialog, GenericNoteDialog } from "./home/NoteDialog";
import type { NoteTarget }   from "./home/NoteDialog";
import { LogsDialog }        from "./home/LogsDialog";
import { GuidedStackDialog } from "./home/GuidedStackDialog";
import { DeleteStackDialog } from "./home/DeleteStackDialog";
import { PullUpdateDialog }     from "./home/PullUpdateDialog";
import { MigrateCasaosDialog }  from "./home/MigrateCasaosDialog";
import { UpdatesDialog }        from "./home/UpdatesDialog";
import { UpdateReportDialog }   from "./home/UpdateReportDialog";
import { BookmarkDialog }    from "./home/BookmarkDialog";
import { ContainerLogsDialog }  from "./home/ContainerLogsDialog";
import { MountPickerDialog }    from "./home/MountPickerDialog";
import { ConfirmDialog }        from "../components/ConfirmDialog";
import { api }               from "../lib/api";
import { useFileStore }      from "../stores/fileStore";

import type { Stack, StackAction, Bookmark } from "./home/types";

export function HomePage({ username, onLogout, onNavigate }: {
  username: string;
  onLogout: () => void;
  onNavigate: (path: string) => void;
}) {
  const { hasPasskey, registerPasskey } = useAuthStore();

  const {
    stacks, stats, summary, version,
    sortMode, setSortMode,
    dragSrcIdx, dragOverIdx, setDragSrcIdx, setDragOverIdx,
    newStackOpen, setNewStackOpen,
    detailStack, setDetailStack,
    noteStack, setNoteStack,
    deleteStack, setDeleteStack,
    logsFor,
    guidedEditStack, setGuidedEditStack,
    pullStack, setPullStack,
    migrateStack, setMigrateStack,
    mountPickerStack, mountPickerPaths, setMountPicker,
    installLogStack, installLogText, installLogLoading,
    actionBusy,
    initialize, loadStacks, stackAction, handleDrop,
  } = useStacksStore();

  const {
    bookmarks,
    addOpen, setAddOpen,
    editTarget, setEdit,
    noteTarget, setNote,
    deleteTarget, setDelete,
    handleAction: bookmarkAction,
    saveNote: saveBookmarkNote,
    remove: deleteBookmark,
    load: loadBookmarks,
  } = useBookmarkStore();

  // Lazy-init: starts polling, loads stacks + stats + bookmarks. Runs once per mount.
  // Also kicks off a background docker image update check.
  useEffect(() => {
    initialize();
    void loadBookmarks();
    // Attach to the checker's stream, then ask for a sweep. The request is marked `auto`,
    // so the server drops it when a recent run exists — several tabs opening together do
    // not each trigger work, and the decision stays in one place rather than per client.
    const checker = useUpdateCheckStore.getState();
    checker.connect();
    void checker.startCheck({ auto: true });
    return () => { useUpdateCheckStore.getState().disconnect(); };
  }, []);

  const [filter, setFilter] = useState("");
  const [pendingAction, setPendingAction] = useState<
    { action: "stop" | "restart"; stack: Stack } | null
  >(null);
  const [pendingDeleteBookmark, setPendingDeleteBookmark] = useState<Bookmark | null>(null);
  const [massUpdateOpen, setMassUpdateOpen] = useState(false);
  const reportOpen = useUpdateCheckStore(s => s.dialogOpen);

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

  // ── Filtered bookmarks ────────────────────────────────────────────────────

  const displayedBookmarks = useMemo<Bookmark[]>(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return bookmarks;
    return bookmarks.filter(b =>
      b.title.toLowerCase().includes(q) || b.url.toLowerCase().includes(q)
    );
  }, [bookmarks, filter]);

  // ── Section counts ────────────────────────────────────────────────────────
  //
  // Counted from the displayed lists, not the full ones, so the numbers always describe
  // what is actually on screen while a filter is active.

  const stackCounts = useMemo(() => {
    let running = 0, partial = 0, stopped = 0;
    for (const s of displayedStacks) {
      if (s.state === "running")      running++;
      else if (s.state === "partial") partial++;
      else                            stopped++;
    }
    return { running, partial, stopped };
  }, [displayedStacks]);

  // "partial" (some services up, some down) is omitted when zero — it is the uncommon
  // case, and naming it every time would crowd the far more useful running/stopped pair.
  const stackCountLabel = [
    `${stackCounts.running} running`,
    ...(stackCounts.partial > 0 ? [`${stackCounts.partial} partial`] : []),
    `${stackCounts.stopped} stopped`,
  ].join(" · ");

  // ── Bookmark note target ──────────────────────────────────────────────────

  const bookmarkNoteTarget: NoteTarget | null = noteTarget
    ? {
        label:       noteTarget.title,
        initialNote: noteTarget.note ?? "",
        onSave: async (note) => {
          const { error } = await api.api.bookmarks({ id: String(noteTarget.id) }).patch({ note: note || null });
          return { error };
        },
      }
    : null;

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

          {/* Host-wide totals — unaffected by the search filter, unlike the section
              counts below, which describe only what is currently rendered. */}
          <DockerSummaryBar summary={summary} />

          {/* ── Docker Stacks section ─────────────────────────────────────── */}
          <p className="text-[10px] text-gray-600 font-semibold uppercase tracking-widest mb-3">
            Docker Stacks
            <span className="ml-2 text-gray-500 normal-case tracking-normal font-normal">
              ({stackCountLabel})
            </span>
          </p>

          <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-4 mb-8">

            {/* Files tile — opens in a new tab so the dashboard stays put */}
            <a
              href="/files"
              target="_blank"
              rel="noopener noreferrer"
              className="bg-gray-900 border border-dashed border-gray-700 rounded-2xl p-5 flex flex-col items-center gap-3 cursor-pointer hover:border-amber-500/50 hover:bg-gray-800/50 hover:scale-[1.02] transition-all select-none"
            >
              <div className="w-16 h-16 rounded-2xl bg-gray-800 border border-gray-700 flex items-center justify-center text-4xl">
                📁
              </div>
              <div className="text-center">
                <p className="text-sm text-gray-200 font-medium">Files</p>
                <p className="text-xs text-gray-600 mt-0.5">File manager</p>
              </div>
            </a>

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
                onAction={(action: StackAction) => {
                  if (action === "stop" || action === "restart") {
                    setPendingAction({ action, stack: s });
                  } else {
                    void stackAction(s, action, onNavigate);
                  }
                }}
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

          {/* ── External Apps section ─────────────────────────────────────── */}
          <p className="text-[10px] text-gray-600 font-semibold uppercase tracking-widest mb-3">
            External Apps
            <span className="ml-2 text-gray-500 normal-case tracking-normal font-normal">
              ({displayedBookmarks.length} {displayedBookmarks.length === 1 ? "link" : "links"})
            </span>
          </p>

          <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-4">

            {/* Add bookmark tile */}
            <button
              type="button"
              aria-label="Add app"
              onClick={() => setAddOpen(true)}
              className="bg-gray-900 border border-dashed border-gray-700 rounded-2xl p-5 flex flex-col items-center gap-3 cursor-pointer hover:border-sky-500/50 hover:bg-gray-800/50 hover:scale-[1.02] transition-all select-none"
            >
              <div className="w-16 h-16 rounded-2xl bg-gray-800 border border-gray-700 flex items-center justify-center text-4xl font-light text-sky-400">
                +
              </div>
              <div className="text-center">
                <p className="text-sm text-gray-200 font-medium">Add App</p>
                <p className="text-xs text-gray-600 mt-0.5">External link</p>
              </div>
            </button>

            {displayedBookmarks.map(b => (
              <BookmarkTile
                key={b.id}
                bookmark={b}
                onAction={action => {
                  if (action === "delete") {
                    setPendingDeleteBookmark(b);
                  } else {
                    bookmarkAction(b, action);
                  }
                }}
              />
            ))}
          </div>

        </main>
      </div>

      <BottomBar stacks={stacks} />

      {/* ── Stack Dialogs ── */}
      <GuidedStackDialog
        mode="create"
        open={newStackOpen}
        onClose={() => setNewStackOpen(false)}
        onDone={() => void loadStacks()}
      />

      {detailStack && (
        <StackDetailDialog
          stack={detailStack}
          open={detailStack !== null}
          onClose={() => setDetailStack(null)}
        />
      )}

      <NoteDialog
        stack={noteStack}
        open={noteStack !== null}
        onClose={() => setNoteStack(null)}
        onSaved={() => { void loadStacks(); }}
      />

      <ContainerLogsDialog
        open={logsFor !== null}
        stack={logsFor}
        onClose={() => useStacksStore.setState({ logsFor: null })}
      />

      <DeleteStackDialog
        stack={deleteStack}
        open={deleteStack !== null}
        onClose={() => setDeleteStack(null)}
        onDeleted={() => { void loadStacks(); }}
      />

      <GuidedStackDialog
        mode="edit"
        stack={guidedEditStack}
        open={guidedEditStack !== null}
        onClose={() => setGuidedEditStack(null)}
        onDone={() => void loadStacks()}
      />

      <PullUpdateDialog
        stack={pullStack}
        open={pullStack !== null}
        onClose={() => setPullStack(null)}
        onUpdated={() => { void loadStacks(); }}
      />

      <MigrateCasaosDialog
        stack={migrateStack}
        open={migrateStack !== null}
        onClose={() => setMigrateStack(null)}
        onDone={() => { setMigrateStack(null); void loadStacks(); }}
      />

      <LogsDialog
        open={installLogStack !== null}
        stack={installLogStack}
        logs={installLogText}
        loading={installLogLoading}
        onClose={() => useStacksStore.setState({ installLogStack: null })}
      />

      {/* "View report" reads results; the mass-update dialog acts on them. Kept apart so
          seeing what is outdated never requires starting work. */}
      <UpdateReportDialog
        open={reportOpen}
        onClose={() => useUpdateCheckStore.getState().closeDialog()}
        onUpdateStacks={() => { useUpdateCheckStore.getState().closeDialog(); setMassUpdateOpen(true); }}
      />

      <UpdatesDialog
        open={massUpdateOpen}
        onClose={() => setMassUpdateOpen(false)}
        onUpdated={() => void loadStacks()}
      />

      {mountPickerStack && (
        <MountPickerDialog
          stack={mountPickerStack}
          paths={mountPickerPaths}
          onPick={(path) => {
            useFileStore.getState().setPendingPath(path);
            setMountPicker(null);
            onNavigate("/files");
          }}
          onClose={() => setMountPicker(null)}
        />
      )}

      <ConfirmDialog
        open={pendingAction !== null}
        title={pendingAction?.action === "stop" ? "Stop stack?" : "Restart stack?"}
        message={`This will ${pendingAction?.action ?? ""} all containers in "${
          pendingAction?.stack.meta?.title ?? pendingAction?.stack.name ?? ""
        }". Continue?`}
        confirmLabel={pendingAction?.action === "stop" ? "Stop" : "Restart"}
        danger={pendingAction?.action === "stop"}
        onConfirm={() => {
          if (pendingAction) void stackAction(pendingAction.stack, pendingAction.action);
          setPendingAction(null);
        }}
        onCancel={() => setPendingAction(null)}
      />

      {/* ── Bookmark Dialogs ── */}
      <BookmarkDialog
        bookmark={null}
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onSaved={() => { void loadBookmarks(); }}
      />

      <BookmarkDialog
        bookmark={editTarget}
        open={editTarget !== null}
        onClose={() => setEdit(null)}
        onSaved={() => { void loadBookmarks(); }}
      />

      <GenericNoteDialog
        target={bookmarkNoteTarget}
        open={noteTarget !== null}
        onClose={() => setNote(null)}
        onSaved={() => {
          void loadBookmarks();
          setNote(null);
        }}
      />

      <ConfirmDialog
        open={pendingDeleteBookmark !== null}
        title="Delete bookmark?"
        message={`Remove "${pendingDeleteBookmark?.title ?? ""}" from your External Apps?`}
        confirmLabel="Delete"
        danger
        onConfirm={() => {
          if (pendingDeleteBookmark) void deleteBookmark(pendingDeleteBookmark.id);
          setPendingDeleteBookmark(null);
        }}
        onCancel={() => setPendingDeleteBookmark(null)}
      />

    </div>
  );
}
