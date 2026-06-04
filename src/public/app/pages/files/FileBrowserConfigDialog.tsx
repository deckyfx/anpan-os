import { useState, useEffect } from "react";
import { Bookmark, Trash2, FolderOpen } from "lucide-react";
import { Dialog }        from "../../components/Dialog";
import { useFileStore }  from "../../stores/fileStore";
import type { FileBookmark } from "./types";

interface Props {
  open:    boolean;
  onClose: () => void;
}

/**
 * Dialog for configuring the file browser: start path, persist-last-path toggle,
 * and a manageable bookmarks list.
 */
export function FileBrowserConfigDialog({ open, onClose }: Props) {
  const { fileBrowserConfig, saveFileBrowserConfig, currentPath } = useFileStore();

  const [startPath,       setStartPath]       = useState(fileBrowserConfig.startPath);
  const [persistLastPath, setPersistLastPath] = useState(fileBrowserConfig.persistLastPath);
  const [bookmarks,       setBookmarks]       = useState<FileBookmark[]>(fileBrowserConfig.bookmarks);

  // Sync local state whenever dialog opens or config changes
  useEffect(() => {
    if (open) {
      setStartPath(fileBrowserConfig.startPath);
      setPersistLastPath(fileBrowserConfig.persistLastPath);
      setBookmarks([...fileBrowserConfig.bookmarks]);
    }
  }, [open, fileBrowserConfig]);

  function handleSave() {
    void saveFileBrowserConfig({ startPath, persistLastPath, bookmarks });
    onClose();
  }

  function handleAddCurrentPath() {
    const segments = currentPath.split("/").filter(Boolean);
    const label    = segments[segments.length - 1] ?? currentPath;
    if (bookmarks.some(b => b.path === currentPath)) return;
    setBookmarks(prev => [...prev, { name: label, path: currentPath }]);
  }

  function handleRemoveBookmark(path: string) {
    setBookmarks(prev => prev.filter(b => b.path !== path));
  }

  function handleRenameBookmark(path: string, newName: string) {
    setBookmarks(prev => prev.map(b => b.path === path ? { ...b, name: newName } : b));
  }

  const footer = (
    <div className="flex gap-2">
      <button
        onClick={onClose}
        className="px-4 py-2 rounded-lg text-sm text-gray-300 hover:text-white hover:bg-gray-800 transition-colors"
      >
        Cancel
      </button>
      <button
        onClick={handleSave}
        className="px-4 py-2 rounded-lg text-sm font-medium bg-blue-600 hover:bg-blue-700 text-white transition-colors"
      >
        Save
      </button>
    </div>
  );

  return (
    <Dialog open={open} title="File Browser Settings" onClose={onClose} footer={footer} size="md">
      <div className="space-y-6">

        {/* ── Section 1: Start Path ──────────────────────────────────── */}
        <div className="space-y-2">
          <label className="block text-sm font-medium text-gray-200">
            Start Path
          </label>
          <div className="flex gap-2">
            <input
              value={startPath}
              onChange={(e) => setStartPath(e.target.value)}
              placeholder="Leave empty to use default"
              spellCheck={false}
              className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm font-mono text-white outline-none focus:border-blue-500 transition-colors placeholder-gray-600"
            />
            <button
              onClick={() => setStartPath(currentPath)}
              title="Use current path"
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium bg-gray-700 hover:bg-gray-600 text-gray-300 hover:text-white transition-colors shrink-0"
            >
              <FolderOpen size={13} />
              Use current
            </button>
          </div>
        </div>

        {/* ── Section 2: Persist Last Path ──────────────────────────── */}
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-gray-200">Remember last visited path</p>
            <p className="text-xs text-gray-500 mt-0.5">Automatically resume where you left off on next visit</p>
          </div>
          <button
            onClick={() => setPersistLastPath(v => !v)}
            role="switch"
            aria-checked={persistLastPath}
            className={`relative inline-flex w-11 h-6 shrink-0 rounded-full transition-colors focus:outline-none ${
              persistLastPath ? "bg-blue-600" : "bg-gray-700"
            }`}
          >
            <span
              className={`inline-block w-4 h-4 rounded-full bg-white shadow transition-transform mt-1 ${
                persistLastPath ? "translate-x-6" : "translate-x-1"
              }`}
            />
          </button>
        </div>

        {/* ── Section 3: Bookmarks ──────────────────────────────────── */}
        <div className="space-y-2">
          <label className="block text-sm font-medium text-gray-200">
            Bookmarks
          </label>

          <div className="space-y-1">
            {bookmarks.length === 0 ? (
              <p className="text-xs text-gray-600 py-2">No bookmarks yet</p>
            ) : (
              bookmarks.map((bm) => (
                <div
                  key={bm.path}
                  className="flex items-center gap-2 px-3 py-2 rounded-lg bg-gray-800 border border-gray-700/50"
                >
                  <Bookmark size={12} className="text-amber-400 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <input
                      value={bm.name}
                      onChange={(e) => handleRenameBookmark(bm.path, e.target.value)}
                      className="w-full bg-transparent text-sm text-gray-200 outline-none focus:text-white"
                    />
                    <p className="text-xs text-gray-500 font-mono truncate">{bm.path}</p>
                  </div>
                  <button
                    onClick={() => handleRemoveBookmark(bm.path)}
                    title="Remove bookmark"
                    className="p-1 rounded text-gray-600 hover:text-red-400 transition-colors shrink-0"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              ))
            )}
          </div>

          <button
            onClick={handleAddCurrentPath}
            disabled={bookmarks.some(b => b.path === currentPath)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Bookmark size={12} />
            Add current path
          </button>
        </div>

      </div>
    </Dialog>
  );
}
