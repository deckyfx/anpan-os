import { useRef, useEffect } from "react";
import { useFileStore }  from "../stores/fileStore";
import { useAuthStore }  from "../stores/authStore";
import { useStacksStore } from "../stores/stacksStore";
import { TopBar }        from "./home/TopBar";
import { ChevronLeft, ChevronRight, FolderUp, House, LayoutGrid, List,
         FolderOpen, Pencil, Download, Archive, PackageOpen, ShieldCheck, Info,
         Trash2, FolderPlus, Upload } from "lucide-react";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Dialog }        from "../components/Dialog";
import type { FileEntry } from "./files/types";
import { ARCHIVE_EXTS }  from "./files/constants";
import { formatSize }    from "./files/helpers";
import { CtxItem, CtxSep } from "./files/ContextMenu";
import { FilePreview }   from "./files/FilePreview";
import { ChmodDialog }   from "./files/ChmodDialog";
import { ListingTable }  from "./files/ListingTable";
import { GridView }      from "./files/GridView";
import { SambaSection }  from "./files/SambaSection";
import { UploadProgressDialog } from "./files/UploadProgressDialog";

// ─── Component ───────────────────────────────────────────────────────────────

export function FilesPage({ onNavigate }: { onNavigate: (path: string) => void }) {
  const {
    // Nav
    currentPath, addressValue, entries, loadingDir, navError, navHistory, homePath,
    navigateTo, loadDirContent, goBack, goForward, setAddressValue, setNavError,
    // Preview
    drawerEntry, fileContent, fileBinary, saving, saveMsg,
    setDrawerEntry, setFileContent, openFile, saveFile,
    // Rename
    renamingPath, renameValue, setRenamingPath, setRenameValue, commitRename,
    // Delete
    deleteTarget, setDeleteTarget, confirmDelete,
    // New folder
    creatingFolder, newFolderName, setCreatingFolder, setNewFolderName, commitNewFolder,
    // View / selection
    viewMode, setViewMode, selectedPaths, toggleSelect, toggleSelectAll,
    // Context menu
    ctxMenu, setCtxMenu,
    // Upload
    handleUpload,
    // ChMod
    chmodTarget, setChmodTarget,
    // Info
    infoTarget, setInfoTarget,
    // Archive
    archiveDialog, archiveName, archivePaths,
    setArchiveDialog, setArchiveName, setArchivePaths, handleArchive, handleExtract,
  } = useFileStore();

  const { username, logout, hasPasskey, registerPasskey } = useAuthStore();
  const version = useStacksStore(s => s.version);

  useEffect(() => { useFileStore.getState().initialize(); }, []);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const canBack    = navHistory.idx > 0;
  const canForward = navHistory.idx < navHistory.stack.length - 1;

  // ── Row helpers ───────────────────────────────────────────────────────────

  function handleRowClick(e: React.MouseEvent, entry: FileEntry) {
    if (renamingPath === entry.path) return;
    if (e.ctrlKey || e.metaKey) {
      toggleSelect(entry.path);
      return;
    }
    useFileStore.setState({ selectedPaths: new Set() });
    if (entry.isDir) void navigateTo(entry.path);
    else void openFile(entry);
  }

  function handleRowCtx(e: React.MouseEvent, entry: FileEntry) {
    e.preventDefault(); e.stopPropagation();
    setCtxMenu({ x: e.clientX, y: e.clientY, entry });
  }

  function openCtxArchive(entry: FileEntry) {
    const paths = selectedPaths.size > 1 && selectedPaths.has(entry.path)
      ? Array.from(selectedPaths)
      : [entry.path];
    setArchivePaths(paths);
    setArchiveName((paths.length === 1 ? entry.name.replace(/\.[^.]+$/, "") : "archive") + ".zip");
    setArchiveDialog(true);
  }

  const sharedRowProps = {
    entries, creatingFolder, newFolderName, renamingPath, renameValue, selectedPaths,
    onRowClick: handleRowClick, onRowCtx: handleRowCtx,
    onRenameChange: setRenameValue, onRenameCommit: commitRename,
    onRenameCancel: () => setRenamingPath(null),
    onFolderNameChange: setNewFolderName, onFolderCommit: commitNewFolder,
    onFolderCancel: () => setCreatingFolder(false),
    onToggleSelect: toggleSelect, onToggleSelectAll: toggleSelectAll,
  };

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-gray-950 text-white flex flex-col">

      <TopBar
        username={username}
        version={version}
        hasPasskey={hasPasskey}
        onLogout={logout}
        onNavigate={onNavigate}
        onAddPasskey={() => registerPasskey("This device")}
        currentPath="/files"
      />

      {/* Toolbar */}
      <div className="px-5 py-3 flex items-center gap-2 border-b border-gray-900">
        <button onClick={goBack} disabled={!canBack || loadingDir} title="Back"
          className="p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-gray-800 transition-colors disabled:opacity-30 disabled:cursor-not-allowed shrink-0">
          <ChevronLeft size={16} />
        </button>
        <button onClick={goForward} disabled={!canForward || loadingDir} title="Forward"
          className="p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-gray-800 transition-colors disabled:opacity-30 disabled:cursor-not-allowed shrink-0">
          <ChevronRight size={16} />
        </button>
        <button onClick={() => navigateTo(currentPath.replace(/\/[^/]+$/, "") || "/")} disabled={currentPath === "/" || loadingDir} title="Up"
          className="p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-gray-800 transition-colors disabled:opacity-30 disabled:cursor-not-allowed shrink-0">
          <FolderUp size={16} />
        </button>
        <button onClick={() => navigateTo(homePath)} disabled={loadingDir} title="Home"
          className="p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-gray-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed shrink-0">
          <House size={16} />
        </button>

        <input
          value={addressValue}
          onChange={(e) => setAddressValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") navigateTo(addressValue); }}
          spellCheck={false}
          className="flex-1 bg-gray-900 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-gray-200 font-mono outline-none focus:border-blue-500 transition-colors"
          placeholder="/path/to/directory"
        />
        <button onClick={() => navigateTo(addressValue)} disabled={loadingDir}
          className="px-3 py-1.5 rounded-lg text-xs font-medium bg-blue-600 hover:bg-blue-700 text-white transition-colors disabled:opacity-50 shrink-0">
          Go
        </button>

        <span className="text-gray-800">|</span>

        <input ref={fileInputRef} type="file" multiple className="hidden"
          onChange={(e) => { handleUpload(e.target.files); e.target.value = ""; }} />
        <button onClick={() => fileInputRef.current?.click()}
          className="px-3 py-1.5 rounded-lg text-xs font-medium bg-gray-800 hover:bg-gray-700 text-gray-300 hover:text-white transition-colors disabled:opacity-50 shrink-0">
          ↑ Upload
        </button>
        <button onClick={() => { setCreatingFolder(true); setNewFolderName(""); }}
          className="px-3 py-1.5 rounded-lg text-xs font-medium bg-gray-800 hover:bg-gray-700 text-gray-300 hover:text-white transition-colors shrink-0">
          + Folder
        </button>

        <button onClick={() => setViewMode(viewMode === "list" ? "grid" : "list")}
          title={viewMode === "list" ? "Grid view" : "List view"}
          className="p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-gray-800 transition-colors shrink-0">
          {viewMode === "list" ? <LayoutGrid size={16} /> : <List size={16} />}
        </button>
      </div>

      {/* File listing */}
      <div
        className="flex-1 px-5 py-4 overflow-auto"
        onContextMenu={(e) => { e.preventDefault(); setCtxMenu({ x: e.clientX, y: e.clientY, entry: null }); }}
      >
        {loadingDir ? (
          <p className="text-gray-500 text-sm">Loading…</p>
        ) : viewMode === "list" ? (
          <ListingTable {...sharedRowProps} />
        ) : (
          <GridView {...sharedRowProps} />
        )}
      </div>

      <SambaSection />

      {/* ── Dialogs ───────────────────────────────────────────────────────── */}

      {/* File preview */}
      <Dialog open={!!drawerEntry} title={drawerEntry?.name ?? ""} onClose={() => setDrawerEntry(null)} size="xl">
        {drawerEntry && (
          <FilePreview
            entry={drawerEntry} content={fileContent} binary={fileBinary}
            onContentChange={setFileContent} onSave={saveFile} saving={saving} saveMsg={saveMsg}
          />
        )}
      </Dialog>

      {/* Nav error */}
      <Dialog open={!!navError} title="Cannot open path" onClose={() => setNavError("")}
        footer={<button onClick={() => setNavError("")} className="px-4 py-2 rounded-lg text-sm font-medium bg-gray-700 hover:bg-gray-600 text-white transition-colors">OK</button>}>
        <p className="text-sm text-gray-300 font-mono break-all">{navError}</p>
      </Dialog>

      {/* Delete confirm */}
      <ConfirmDialog open={!!deleteTarget} title="Delete"
        message={`Delete "${deleteTarget?.name}"? This cannot be undone.`}
        confirmLabel="Delete" danger onConfirm={confirmDelete} onCancel={() => setDeleteTarget(null)} />

      {/* ChMod */}
      <ChmodDialog
        entry={chmodTarget}
        open={!!chmodTarget}
        onClose={() => setChmodTarget(null)}
        onApplied={() => void loadDirContent(currentPath)}
      />

      {/* Info */}
      <Dialog open={!!infoTarget} title="Info" onClose={() => setInfoTarget(null)}
        footer={<button onClick={() => setInfoTarget(null)} className="px-4 py-2 rounded-lg text-sm bg-gray-700 hover:bg-gray-600 text-white transition-colors">Close</button>}>
        {infoTarget && (
          <dl className="space-y-2 text-sm">
            {(
              [
                ["Name",     infoTarget.name],
                ["Path",     infoTarget.path],
                ["Type",     infoTarget.isDir ? "Directory" : `File (.${infoTarget.ext || "?"})`],
                ...(!infoTarget.isDir ? [["Size", formatSize(infoTarget.size)] as [string, string]] : []),
                ["Modified", new Date(infoTarget.modified).toLocaleString()],
                ["Mode",     infoTarget.mode],
                ["UID",      String(infoTarget.uid)],
                ["GID",      String(infoTarget.gid)],
              ] as [string, string][]
            ).map(([label, value]) => (
              <div key={label} className="flex gap-3">
                <dt className="w-20 shrink-0 text-gray-500">{label}</dt>
                <dd className="text-gray-200 font-mono break-all">{value}</dd>
              </div>
            ))}
          </dl>
        )}
      </Dialog>

      {/* Archive */}
      <Dialog open={archiveDialog} title="Create Archive" onClose={() => setArchiveDialog(false)}
        footer={
          <div className="flex gap-2 justify-end">
            <button onClick={() => setArchiveDialog(false)} className="px-4 py-2 rounded-lg text-sm text-gray-300 hover:text-white hover:bg-gray-800 transition-colors">Cancel</button>
            <button onClick={handleArchive} className="px-4 py-2 rounded-lg text-sm font-medium bg-blue-600 hover:bg-blue-700 text-white transition-colors">Create</button>
          </div>
        }>
        <div className="space-y-3">
          <p className="text-xs text-gray-400">{archivePaths.length} item{archivePaths.length !== 1 ? "s" : ""} → archive name:</p>
          <input autoFocus value={archiveName} onChange={(e) => setArchiveName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleArchive(); }}
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm font-mono text-white outline-none focus:border-blue-500" />
        </div>
      </Dialog>

      <UploadProgressDialog />

      {/* Context menu */}
      {ctxMenu && (
        <>
          <div
            className="fixed inset-0 z-90"
            tabIndex={-1}
            ref={(el) => el?.focus()}
            onClick={() => setCtxMenu(null)}
            onKeyDown={(e) => { if (e.key === "Escape") setCtxMenu(null); }}
            onContextMenu={(e) => { e.preventDefault(); setCtxMenu(null); }}
          />
          <div
            className="fixed z-91 min-w-42 bg-gray-800 border border-gray-700 rounded-lg shadow-2xl py-1 overflow-hidden"
            style={{ left: Math.min(ctxMenu.x, window.innerWidth - 180), top: Math.min(ctxMenu.y, window.innerHeight - 260) }}
          >
            {ctxMenu.entry ? (
              <>
                <CtxItem label="Open"   icon={<FolderOpen   size={14} />} onClick={() => { const e = ctxMenu.entry!; setCtxMenu(null); e.isDir ? void navigateTo(e.path) : void openFile(e); }} />
                <CtxItem label="Rename" icon={<Pencil        size={14} />} onClick={() => { const e = ctxMenu.entry!; setRenamingPath(e.path); setRenameValue(e.name); setCtxMenu(null); }} />
                <CtxSep />
                {!ctxMenu.entry.isDir && (
                  <CtxItem label="Download"    icon={<Download    size={14} />} onClick={() => { window.open(`/api/files/download?path=${encodeURIComponent(ctxMenu.entry!.path)}`); setCtxMenu(null); }} />
                )}
                <CtxItem label="Archive…"    icon={<Archive     size={14} />} onClick={() => { const e = ctxMenu.entry!; setCtxMenu(null); openCtxArchive(e); }} />
                {ARCHIVE_EXTS.has(ctxMenu.entry.ext) && (
                  <CtxItem label="Extract here" icon={<PackageOpen size={14} />} onClick={() => { const e = ctxMenu.entry!; setCtxMenu(null); void handleExtract(e); }} />
                )}
                <CtxSep />
                <CtxItem label="Permissions…" icon={<ShieldCheck  size={14} />} onClick={() => { setChmodTarget(ctxMenu.entry!); setCtxMenu(null); }} />
                <CtxItem label="Info"          icon={<Info         size={14} />} onClick={() => { setInfoTarget(ctxMenu.entry!); setCtxMenu(null); }} />
                <CtxSep />
                <CtxItem label="Delete" danger icon={<Trash2       size={14} />} onClick={() => { setDeleteTarget(ctxMenu.entry!); setCtxMenu(null); }} />
              </>
            ) : (
              <>
                <CtxItem label="New Folder"    icon={<FolderPlus size={14} />} onClick={() => { setCreatingFolder(true); setNewFolderName(""); setCtxMenu(null); }} />
                <CtxItem label="Upload files…" icon={<Upload      size={14} />} onClick={() => { fileInputRef.current?.click(); setCtxMenu(null); }} />
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
