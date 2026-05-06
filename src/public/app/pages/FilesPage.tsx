import { useRef, useState } from "react";
import { useFileStore } from "../stores/fileStore";
import { ChevronLeft, ChevronRight, FolderUp, House, LayoutDashboard, LayoutGrid, List,
         FolderOpen, Pencil, Download, Archive, PackageOpen, ShieldCheck, Info,
         Trash2, FolderPlus, Upload } from "lucide-react";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Dialog }        from "../components/Dialog";
import type { FileEntry } from "./files/types";
import { ARCHIVE_EXTS }  from "./files/constants";
import { formatSize, formatDate, parentPath } from "./files/helpers";
import { FileIcon }      from "./files/FileIcon";
import { CtxItem, CtxSep } from "./files/ContextMenu";
import { FilePreview }   from "./files/FilePreview";

// ─── Component ───────────────────────────────────────────────────────────────

export function FilesPage({ onNavigate }: { onNavigate: (path: string) => void }) {
  const {
    // Nav
    currentPath, addressValue, entries, loadingDir, navError, navHistory, homePath,
    navigateTo, goBack, goForward, setAddressValue, setNavError,
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
    uploadItems, setUploadItems, handleUpload,
    // ChMod
    chmodTarget, chmodValue, setChmodTarget, setChmodValue, handleChmod,
    // Info
    infoTarget, setInfoTarget,
    // Archive
    archiveDialog, archiveName, archivePaths,
    setArchiveDialog, setArchiveName, setArchivePaths, handleArchive, handleExtract,
    // Samba
    shares, sambaOpen, removeShareTarget, addShareOpen, newShare, reloadingSmbd,
    setSambaOpen, setRemoveShareTarget, setAddShareOpen, setNewShare,
    addShare, removeShare, reloadSmbd,
    // Init
    initialize,
  } = useFileStore();

  // Lazy-init: load home dir + shares once, no useEffect needed.
  useState(() => { initialize(); });

  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadDialogOpen = uploadItems.length > 0;

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

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-gray-950 text-white flex flex-col">

      {/* Top bar */}
      <header className="border-b border-gray-800 px-5 py-3 flex items-center gap-3">
        <button onClick={() => onNavigate("/")} className="flex items-center gap-1.5 text-gray-400 hover:text-white transition-colors text-sm">
          <LayoutDashboard size={14} />
          Dashboard
        </button>
        <span className="text-gray-700">|</span>
        <span className="text-sm font-medium text-gray-300">File Manager</span>
      </header>

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
        <button onClick={() => navigateTo(parentPath(currentPath))} disabled={currentPath === "/" || loadingDir} title="Up"
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
        <button onClick={() => fileInputRef.current?.click()} disabled={uploadDialogOpen}
          className="px-3 py-1.5 rounded-lg text-xs font-medium bg-gray-800 hover:bg-gray-700 text-gray-300 hover:text-white transition-colors disabled:opacity-50 shrink-0">
          ↑ Upload
        </button>
        <button onClick={() => { setCreatingFolder(true); setNewFolderName(""); }}
          className="px-3 py-1.5 rounded-lg text-xs font-medium bg-gray-800 hover:bg-gray-700 text-gray-300 hover:text-white transition-colors shrink-0">
          + Folder
        </button>

        {/* View mode toggle */}
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
          <ListingTable
            entries={entries}
            creatingFolder={creatingFolder}
            newFolderName={newFolderName}
            renamingPath={renamingPath}
            renameValue={renameValue}
            selectedPaths={selectedPaths}
            onRowClick={handleRowClick}
            onRowCtx={handleRowCtx}
            onRenameChange={setRenameValue}
            onRenameCommit={commitRename}
            onRenameCancel={() => setRenamingPath(null)}
            onFolderNameChange={setNewFolderName}
            onFolderCommit={commitNewFolder}
            onFolderCancel={() => setCreatingFolder(false)}
            onToggleSelect={toggleSelect}
            onToggleSelectAll={toggleSelectAll}
          />
        ) : (
          <GridView
            entries={entries}
            creatingFolder={creatingFolder}
            newFolderName={newFolderName}
            renamingPath={renamingPath}
            renameValue={renameValue}
            selectedPaths={selectedPaths}
            onRowClick={handleRowClick}
            onRowCtx={handleRowCtx}
            onRenameChange={setRenameValue}
            onRenameCommit={commitRename}
            onRenameCancel={() => setRenamingPath(null)}
            onFolderNameChange={setNewFolderName}
            onFolderCommit={commitNewFolder}
            onFolderCancel={() => setCreatingFolder(false)}
            onToggleSelect={toggleSelect}
            onToggleSelectAll={toggleSelectAll}
          />
        )}
      </div>

      {/* Samba section */}
      <div className="border-t border-gray-800 px-5 py-3">
        <button
          onClick={() => setSambaOpen(!sambaOpen)}
          className="flex items-center gap-2 text-sm text-gray-400 hover:text-white transition-colors w-full text-left"
        >
          <span className={`transition-transform ${sambaOpen ? "rotate-90" : ""}`}>›</span>
          <span>Samba Shares</span>
          <span className="flex-1 border-t border-gray-800 ml-2" />
          <button
            onClick={(e) => { e.stopPropagation(); setNewShare({ ...newShare, path: currentPath }); setAddShareOpen(true); }}
            className="text-xs px-2 py-0.5 rounded bg-gray-800 hover:bg-gray-700 text-gray-300 hover:text-white transition-colors"
          >+</button>
        </button>
        {sambaOpen && (
          <div className="mt-3 space-y-2">
            {shares.length === 0 && <p className="text-gray-600 text-xs">No shares configured.</p>}
            {shares.map((share) => (
              <div key={share.name} className="flex items-center justify-between gap-2 text-sm">
                <div className="flex-1 min-w-0">
                  <span className="font-medium text-gray-300">{share.name}</span>
                  <span className="text-gray-600 ml-2 truncate">{share.path}</span>
                </div>
                <button onClick={() => setRemoveShareTarget(share)} className="text-xs text-red-500 hover:text-red-400 transition-colors shrink-0">Remove</button>
              </div>
            ))}
            {shares.length > 0 && (
              <div className="flex justify-end pt-1">
                <button onClick={reloadSmbd} disabled={reloadingSmbd}
                  className="text-xs px-3 py-1 rounded bg-gray-800 hover:bg-gray-700 text-gray-300 hover:text-white transition-colors disabled:opacity-50">
                  {reloadingSmbd ? "Reloading…" : "Reload smbd"}
                </button>
              </div>
            )}
          </div>
        )}
      </div>

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

      {/* Add Samba share */}
      {addShareOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
          onClick={(e) => { if (e.target === e.currentTarget) setAddShareOpen(false); }}>
          <div className="w-full max-w-md bg-gray-900 border border-gray-700 rounded-xl shadow-2xl">
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
              <h2 className="text-base font-semibold text-white">Add Samba Share</h2>
              <button onClick={() => setAddShareOpen(false)} className="text-gray-400 hover:text-white text-xl">✕</button>
            </div>
            <div className="px-5 py-4 space-y-3">
              {(["name","path","comment"] as const).map((field) => (
                <label key={field} className="block">
                  <span className="text-xs text-gray-400 block mb-1 capitalize">{field === "comment" ? "Comment (optional)" : field === "name" ? "Share Name" : "Path"}</span>
                  <input value={newShare[field]} onChange={(e) => setNewShare({ ...newShare, [field]: e.target.value })}
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-blue-500" />
                </label>
              ))}
              <label className="flex items-center gap-2 text-sm text-gray-300">
                <input type="checkbox" checked={newShare.readOnly} onChange={(e) => setNewShare({ ...newShare, readOnly: e.target.checked })} />
                Read only
              </label>
            </div>
            <div className="px-5 py-4 border-t border-gray-800 flex justify-end gap-2">
              <button onClick={() => setAddShareOpen(false)} className="px-4 py-2 rounded-lg text-sm text-gray-300 hover:text-white hover:bg-gray-800 transition-colors">Cancel</button>
              <button onClick={addShare} className="px-4 py-2 rounded-lg text-sm font-medium bg-blue-600 hover:bg-blue-700 text-white transition-colors">Add Share</button>
            </div>
          </div>
        </div>
      )}

      {/* Nav error */}
      <Dialog open={!!navError} title="Cannot open path" onClose={() => setNavError("")}
        footer={<button onClick={() => setNavError("")} className="px-4 py-2 rounded-lg text-sm font-medium bg-gray-700 hover:bg-gray-600 text-white transition-colors">OK</button>}>
        <p className="text-sm text-gray-300 font-mono break-all">{navError}</p>
      </Dialog>

      {/* Delete confirm */}
      <ConfirmDialog open={!!deleteTarget} title="Delete"
        message={`Delete "${deleteTarget?.name}"? This cannot be undone.`}
        confirmLabel="Delete" danger onConfirm={confirmDelete} onCancel={() => setDeleteTarget(null)} />

      {/* Remove share confirm */}
      <ConfirmDialog open={!!removeShareTarget} title="Remove Share"
        message={`Remove Samba share "${removeShareTarget?.name}"?`}
        confirmLabel="Remove" danger onConfirm={removeShare} onCancel={() => setRemoveShareTarget(null)} />

      {/* Upload progress */}
      {uploadDialogOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="w-full max-w-sm bg-gray-900 border border-gray-700 rounded-xl shadow-2xl">
            <div className="px-5 py-4 border-b border-gray-800">
              <h2 className="text-base font-semibold text-white">Uploading</h2>
            </div>
            <div className="px-5 py-4 space-y-3 max-h-60 overflow-y-auto">
              {uploadItems.map((item, i) => (
                <div key={i} className="space-y-1">
                  <div className="flex items-center justify-between text-xs text-gray-400">
                    <span className="truncate mr-2 flex-1">{item.name}</span>
                    <span className="shrink-0 font-mono">
                      {item.error ? "❌" : item.done ? "✅" : `${Math.round((item.loaded / Math.max(item.total, 1)) * 100)}%`}
                    </span>
                  </div>
                  <div className="h-1 bg-gray-800 rounded-full overflow-hidden">
                    <div
                      className={`h-full transition-all rounded-full ${item.error ? "bg-red-500" : item.done ? "bg-green-500" : "bg-blue-500"}`}
                      style={{ width: `${Math.round((item.loaded / Math.max(item.total, 1)) * 100)}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
            {uploadItems.every(it => it.done) && (
              <div className="px-5 py-3 border-t border-gray-800 flex justify-end">
                <button onClick={() => setUploadItems([])} className="px-4 py-2 rounded-lg text-sm bg-gray-700 hover:bg-gray-600 text-white transition-colors">Done</button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ChMod */}
      <Dialog open={!!chmodTarget} title={`Permissions: ${chmodTarget?.name ?? ""}`} onClose={() => setChmodTarget(null)}
        footer={
          <div className="flex gap-2 justify-end">
            <button onClick={() => setChmodTarget(null)} className="px-4 py-2 rounded-lg text-sm text-gray-300 hover:text-white hover:bg-gray-800 transition-colors">Cancel</button>
            <button onClick={handleChmod} className="px-4 py-2 rounded-lg text-sm font-medium bg-blue-600 hover:bg-blue-700 text-white transition-colors">Apply</button>
          </div>
        }>
        <div className="space-y-3">
          <p className="text-xs text-gray-400">Octal mode (e.g. 755, 644, 600)</p>
          <input autoFocus value={chmodValue} onChange={(e) => setChmodValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleChmod(); }}
            placeholder="755" maxLength={4}
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm font-mono text-white outline-none focus:border-blue-500" />
        </div>
      </Dialog>

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

      {/* Context menu — escape handled by onKeyDown on the backdrop (no useEffect) */}
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
                <CtxItem label="Permissions…" icon={<ShieldCheck  size={14} />} onClick={() => { const e = ctxMenu.entry!; setChmodTarget(e); setChmodValue(e.mode); setCtxMenu(null); }} />
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

// ─── Shared row-editing props ─────────────────────────────────────────────────

interface RowProps {
  entries:        FileEntry[];
  creatingFolder: boolean;
  newFolderName:  string;
  renamingPath:   string | null;
  renameValue:    string;
  selectedPaths:  Set<string>;
  onRowClick:     (e: React.MouseEvent, entry: FileEntry) => void;
  onRowCtx:       (e: React.MouseEvent, entry: FileEntry) => void;
  onRenameChange: (v: string) => void;
  onRenameCommit: (entry: FileEntry) => void;
  onRenameCancel: () => void;
  onFolderNameChange:  (v: string) => void;
  onFolderCommit:      () => void;
  onFolderCancel:      () => void;
  onToggleSelect:      (path: string) => void;
  onToggleSelectAll:   () => void;
}

// ─── List view ────────────────────────────────────────────────────────────────

function ListingTable(props: RowProps) {
  const { entries, creatingFolder, newFolderName, renamingPath, renameValue, selectedPaths,
          onRowClick, onRowCtx, onRenameChange, onRenameCommit, onRenameCancel,
          onFolderNameChange, onFolderCommit, onFolderCancel,
          onToggleSelect, onToggleSelectAll } = props;

  const allSelected  = entries.length > 0 && entries.every(e => selectedPaths.has(e.path));
  const someSelected = entries.some(e => selectedPaths.has(e.path));
  const anySelected  = selectedPaths.size > 0;

  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-left text-gray-600 text-xs uppercase tracking-wide">
          <th className="pb-2 pr-3 w-8">
            {/* Callback ref sets indeterminate directly — no useRef + useEffect needed */}
            <input
              ref={(el) => { if (el) el.indeterminate = someSelected && !allSelected; }}
              type="checkbox" checked={allSelected} onChange={onToggleSelectAll}
              className="w-3.5 h-3.5 rounded accent-blue-500 cursor-pointer"
            />
          </th>
          <th className="pb-2 pr-4 font-medium">Name</th>
          <th className="pb-2 pr-4 font-medium w-16">Type</th>
          <th className="pb-2 pr-4 font-medium w-20 text-right">Size</th>
          <th className="pb-2 font-medium w-20 text-right">Modified</th>
        </tr>
      </thead>
      <tbody>
        {creatingFolder && (
          <tr><td colSpan={5} className="py-1">
            <input autoFocus value={newFolderName} onChange={(e) => onFolderNameChange(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") onFolderCommit(); if (e.key === "Escape") onFolderCancel(); }}
              onBlur={onFolderCommit} placeholder="Folder name…"
              className="bg-gray-800 border border-gray-600 rounded px-2 py-1 text-sm text-white outline-none w-48" />
          </td></tr>
        )}
        {entries.length === 0 && !creatingFolder && (
          <tr><td colSpan={5} className="py-6 text-center text-gray-600 text-xs">Empty directory</td></tr>
        )}
        {entries.map((entry) => {
          const isSelected = selectedPaths.has(entry.path);
          return (
            <tr key={entry.path}
              onClick={(e) => onRowClick(e, entry)}
              onContextMenu={(e) => onRowCtx(e, entry)}
              className={`group border-t border-gray-900 transition-colors cursor-pointer select-none ${
                isSelected ? "bg-blue-950 hover:bg-blue-900" : "hover:bg-gray-900"
              }`}
            >
              <td className="py-2 pr-3 w-8" onClick={(e) => e.stopPropagation()}>
                <input type="checkbox" checked={isSelected}
                  onChange={() => onToggleSelect(entry.path)}
                  className={`w-3.5 h-3.5 rounded accent-blue-500 cursor-pointer transition-opacity ${
                    anySelected ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                  }`}
                />
              </td>
              <td className="py-2 pr-4">
                {renamingPath === entry.path ? (
                  <input autoFocus value={renameValue} onChange={(e) => onRenameChange(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") onRenameCommit(entry); if (e.key === "Escape") onRenameCancel(); }}
                    onBlur={() => onRenameCommit(entry)} onClick={(e) => e.stopPropagation()}
                    className="bg-gray-800 border border-gray-600 rounded px-2 py-0.5 text-sm text-white outline-none" />
                ) : (
                  <span className="flex items-center gap-2">
                    <FileIcon entry={entry} />
                    <span className="text-gray-200">{entry.name}</span>
                  </span>
                )}
              </td>
              <td className="py-2 pr-4 text-gray-500">{entry.isDir ? "dir" : (entry.ext || "—")}</td>
              <td className="py-2 pr-4 text-gray-500 text-right">{entry.isDir ? "—" : formatSize(entry.size)}</td>
              <td className="py-2 text-gray-500 text-right">{formatDate(entry.modified)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// ─── Grid view ────────────────────────────────────────────────────────────────

function GridView(props: RowProps) {
  const { entries, creatingFolder, newFolderName, renamingPath, renameValue, selectedPaths,
          onRowClick, onRowCtx, onRenameChange, onRenameCommit, onRenameCancel,
          onFolderNameChange, onFolderCommit, onFolderCancel,
          onToggleSelect } = props;

  const anySelected = selectedPaths.size > 0;

  return (
    <div className="space-y-2">
      {creatingFolder && (
        <input autoFocus value={newFolderName} onChange={(e) => onFolderNameChange(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") onFolderCommit(); if (e.key === "Escape") onFolderCancel(); }}
          onBlur={onFolderCommit} placeholder="Folder name…"
          className="bg-gray-800 border border-gray-600 rounded px-2 py-1 text-sm text-white outline-none w-48" />
      )}
      {entries.length === 0 && !creatingFolder && (
        <p className="py-6 text-center text-gray-600 text-xs">Empty directory</p>
      )}
      <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(96px, 1fr))" }}>
        {entries.map((entry) => {
          const isSelected = selectedPaths.has(entry.path);
          return (
            <div key={entry.path}
              onClick={(e) => onRowClick(e, entry)}
              onContextMenu={(e) => onRowCtx(e, entry)}
              className={`relative group flex flex-col items-center gap-2 p-3 rounded-xl cursor-pointer transition-colors select-none ${
                isSelected ? "bg-blue-950 hover:bg-blue-900" : "hover:bg-gray-800"
              }`}
            >
              <input type="checkbox" checked={isSelected}
                onChange={() => onToggleSelect(entry.path)}
                onClick={(e) => e.stopPropagation()}
                className={`absolute top-1.5 left-1.5 w-3.5 h-3.5 rounded accent-blue-500 cursor-pointer transition-opacity ${
                  anySelected ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                }`}
              />
              {renamingPath === entry.path ? (
                <input autoFocus value={renameValue} onChange={(e) => onRenameChange(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") onRenameCommit(entry); if (e.key === "Escape") onRenameCancel(); }}
                  onBlur={() => onRenameCommit(entry)} onClick={(e) => e.stopPropagation()}
                  className="bg-gray-800 border border-gray-600 rounded px-2 py-0.5 text-xs text-white outline-none w-full" />
              ) : (
                <>
                  <FileIcon entry={entry} size="lg" />
                  <span className="text-xs text-gray-300 text-center w-full truncate leading-tight">{entry.name}</span>
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
