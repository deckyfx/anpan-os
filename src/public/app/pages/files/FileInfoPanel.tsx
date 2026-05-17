import { useEffect, useState } from "react";
import { X, ClipboardList, FolderSearch } from "lucide-react";
import { api } from "../../lib/api";
import { useFileStore } from "../../stores/fileStore";
import type { DiskMount, SystemStats } from "../home/types";
import type { FileEntry } from "./types";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toGB(bytes: number): string {
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
  if (bytes >= 1_048_576)     return `${(bytes / 1_048_576).toFixed(0)} MB`;
  return `${Math.round(bytes / 1_024)} KB`;
}

function formatSize(bytes: number): string {
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(2)} GB`;
  if (bytes >= 1_048_576)     return `${(bytes / 1_048_576).toFixed(1)} MB`;
  if (bytes >= 1_024)         return `${(bytes / 1_024).toFixed(0)} KB`;
  return `${bytes} B`;
}

function formatDate(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

const cardClass = "bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-2";
const labelClass = "text-[10px] font-semibold text-gray-600 uppercase tracking-widest";
const rowClass = "flex items-start justify-between gap-2 text-xs";
const keyClass = "text-gray-500 shrink-0";
const valClass = "text-gray-300 break-all text-right";

// ─── Disk Usage Widget ────────────────────────────────────────────────────────

/** Shows disk usage for the mount point that best matches the current directory. */
function DiskUsageWidget({ currentPath }: { currentPath: string }) {
  const [disks, setDisks] = useState<DiskMount[] | null>(null);

  useEffect(() => {
    api.api.system.stats.get()
      .then(({ data }) => {
        const d = data as SystemStats | null;
        if (d?.disks) setDisks(d.disks);
      })
      .catch(() => {});
  }, []);

  if (!disks) {
    return (
      <div className={`${cardClass} animate-pulse`}>
        <p className={labelClass}>Disk</p>
        <div className="h-3 bg-gray-800 rounded w-3/4" />
      </div>
    );
  }

  // Find the disk whose mount is the longest prefix of currentPath.
  const relevant = disks
    .filter(d => currentPath === d.mount || currentPath.startsWith(d.mount === "/" ? "/" : d.mount + "/"))
    .sort((a, b) => b.mount.length - a.mount.length)[0] ?? disks[0];

  if (!relevant) return null;
  const pct = relevant.total > 0 ? Math.min(100, Math.round((relevant.used / relevant.total) * 100)) : 0;
  const barColor = pct > 85 ? "bg-red-500" : pct > 65 ? "bg-yellow-400" : "bg-violet-500";

  return (
    <div className={cardClass}>
      <p className={labelClass}>Disk</p>
      <div className="space-y-1">
        <div className={rowClass}>
          <span className={keyClass} title={relevant.device}>{relevant.device.replace("/dev/", "")}</span>
          <span className="text-gray-600 truncate text-right">{relevant.mount}</span>
        </div>
        <div className={rowClass}>
          <span className={keyClass}>{toGB(relevant.used)} used</span>
          <span className="text-gray-600">{toGB(relevant.total)} total</span>
        </div>
        <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden mt-1">
          <div className={`h-full rounded-full transition-all ${barColor}`} style={{ width: `${pct}%` }} />
        </div>
      </div>
    </div>
  );
}

// ─── Clipboard Widget ─────────────────────────────────────────────────────────

/** Displays the current clipboard operation (copy/cut) and lists the affected file names. */
function ClipboardWidget() {
  const { clipboard, clearClipboard } = useFileStore();
  if (!clipboard) return null;

  return (
    <div className={cardClass}>
      <div className="flex items-center justify-between">
        <p className={labelClass}>Clipboard</p>
        <button onClick={clearClipboard} className="text-gray-600 hover:text-gray-300 transition-colors" title="Clear clipboard">
          <X size={12} />
        </button>
      </div>
      <div className={rowClass}>
        <span className={keyClass}>Operation</span>
        <span className={`${valClass} capitalize font-semibold ${clipboard.op === "cut" ? "text-yellow-400" : "text-blue-400"}`}>
          {clipboard.op}
        </span>
      </div>
      <div className={rowClass}>
        <span className={keyClass}>Items</span>
        <span className={valClass}>{clipboard.paths.length}</span>
      </div>
      <div className="space-y-0.5">
        {clipboard.paths.slice(0, 4).map(p => (
          <p key={p} className="text-[10px] text-gray-600 truncate text-right">{p.split("/").pop()}</p>
        ))}
        {clipboard.paths.length > 4 && (
          <p className="text-[10px] text-gray-700">+{clipboard.paths.length - 4} more</p>
        )}
      </div>
    </div>
  );
}

// ─── Selection Widget ─────────────────────────────────────────────────────────

/** Summarises the current selection: item count and total file size (directories excluded). */
function SelectionWidget({ entries, selectedPaths }: {
  entries: FileEntry[];
  selectedPaths: Set<string>;
}) {
  const { toggleSelectAll } = useFileStore();
  if (selectedPaths.size === 0) return null;

  const selected = entries.filter(e => selectedPaths.has(e.path));
  const totalBytes = selected.reduce((sum, e) => !e.isDir ? sum + e.size : sum, 0);
  const hasDir = selected.some(e => e.isDir);

  return (
    <div className={cardClass}>
      <p className={labelClass}>Selection</p>
      <div className={rowClass}>
        <span className={keyClass}>Count</span>
        <span className={valClass}>{selectedPaths.size} items</span>
      </div>
      {totalBytes > 0 && (
        <div className={rowClass}>
          <span className={keyClass}>Size</span>
          <span className={valClass}>{formatSize(totalBytes)}{hasDir && " (files only)"}</span>
        </div>
      )}
      <button
        onClick={toggleSelectAll}
        className="text-[10px] text-gray-600 hover:text-gray-400 transition-colors"
      >
        Deselect all
      </button>
    </div>
  );
}

// ─── Properties Widget ────────────────────────────────────────────────────────

/** Shows metadata for a single file or folder; includes an on-demand size calculator for directories. */
function PropertiesWidget({ entry, folderSizes, onCalculateSize }: {
  entry: FileEntry;
  folderSizes: Record<string, string>;
  onCalculateSize: (path: string) => Promise<void>;
}) {
  const [calculating, setCalculating] = useState(false);

  const handleCalc = async () => {
    setCalculating(true);
    try {
      await onCalculateSize(entry.path);
    } finally {
      setCalculating(false);
    }
  };

  return (
    <div className={cardClass}>
      <p className={labelClass}>Properties</p>
      <div className={rowClass}><span className={keyClass}>Name</span><span className={valClass}>{entry.name}</span></div>
      <div className={rowClass}><span className={keyClass}>Type</span><span className={valClass}>{entry.isDir ? "Directory" : entry.ext ? `.${entry.ext}` : "File"}</span></div>
      <div className={rowClass}>
        <span className={keyClass}>Size</span>
        <span className={valClass}>
          {entry.isDir
            ? (folderSizes[entry.path] ?? (
              <button
                onClick={handleCalc}
                className="flex items-center gap-1 text-blue-400 hover:text-blue-300 transition-colors"
                disabled={calculating}
              >
                <FolderSearch size={11} />
                {calculating ? "Calculating…" : "Calculate"}
              </button>
            ))
            : formatSize(entry.size)}
        </span>
      </div>
      <div className={rowClass}><span className={keyClass}>Modified</span><span className={valClass}>{formatDate(entry.modified)}</span></div>
      <div className={rowClass}><span className={keyClass}>Mode</span><span className={valClass}>{entry.mode}</span></div>
      <div className={rowClass}><span className={keyClass}>UID / GID</span><span className={valClass}>{entry.uid} / {entry.gid}</span></div>
    </div>
  );
}

// ─── FileInfoPanel ────────────────────────────────────────────────────────────

interface FileInfoPanelProps {
  currentPath:  string;
  entries:      FileEntry[];
  selectedPaths: Set<string>;
}

/**
 * Collapsible right sidebar panel showing disk usage, clipboard state,
 * selection summary, and single-item properties.
 */
export function FileInfoPanel({ currentPath, entries, selectedPaths }: FileInfoPanelProps) {
  const { clipboard, folderSizes, calculateFolderSize } = useFileStore();

  const singleSelected = selectedPaths.size === 1
    ? entries.find(e => selectedPaths.has(e.path)) ?? null
    : null;

  return (
    <div className="space-y-3 p-3">
      <DiskUsageWidget currentPath={currentPath} />
      {clipboard && <ClipboardWidget />}
      {selectedPaths.size > 0 && (
        <SelectionWidget
          entries={entries}
          selectedPaths={selectedPaths}
        />
      )}
      {singleSelected && (
        <PropertiesWidget
          entry={singleSelected}
          folderSizes={folderSizes}
          onCalculateSize={calculateFolderSize}
        />
      )}
      {selectedPaths.size === 0 && !clipboard && (
        <div className="text-[11px] text-gray-700 text-center pt-4">
          Select a file or folder to see its properties.
        </div>
      )}
    </div>
  );
}
