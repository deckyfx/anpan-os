import { FileIcon } from "./FileIcon";
import type { RowProps } from "./ListingTable";

// ─── Grid view ────────────────────────────────────────────────────────────────

export function GridView(props: RowProps) {
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
