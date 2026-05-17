import { FileIcon } from "./FileIcon";
import { formatSize, formatDate } from "./helpers";
import type { FileEntry } from "./types";

// ─── Shared row-editing props ─────────────────────────────────────────────────

export interface RowProps {
  entries:           FileEntry[];
  creatingFolder:    boolean;
  newFolderName:     string;
  renamingPath:      string | null;
  renameValue:       string;
  selectedPaths:     Set<string>;
  sharedPaths?:      Set<string>;
  clipboard?:        { op: "copy" | "cut"; paths: string[] } | null;
  onRowClick:        (e: React.MouseEvent, entry: FileEntry) => void;
  onRowCtx:          (e: React.MouseEvent, entry: FileEntry) => void;
  onRenameChange:    (v: string) => void;
  onRenameCommit:    (entry: FileEntry) => void;
  onRenameCancel:    () => void;
  onFolderNameChange: (v: string) => void;
  onFolderCommit:    () => void;
  onFolderCancel:    () => void;
  onToggleSelect:    (path: string) => void;
  onToggleSelectAll: () => void;
}

// ─── List view ────────────────────────────────────────────────────────────────

export function ListingTable(props: RowProps) {
  const { entries, creatingFolder, newFolderName, renamingPath, renameValue, selectedPaths, sharedPaths,
          clipboard, onRowClick, onRowCtx, onRenameChange, onRenameCommit, onRenameCancel,
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
          const isCut = clipboard?.op === "cut" && clipboard.paths.includes(entry.path);
          return (
            <tr key={entry.path}
              onClick={(e) => onRowClick(e, entry)}
              onContextMenu={(e) => onRowCtx(e, entry)}
              className={`group border-t border-gray-900 transition-colors cursor-pointer select-none ${
                isSelected ? "bg-blue-950 hover:bg-blue-900" : "hover:bg-gray-900"
              } ${isCut ? "opacity-40" : ""}`}
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
                    <FileIcon entry={entry} shared={sharedPaths?.has(entry.path)} />
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
