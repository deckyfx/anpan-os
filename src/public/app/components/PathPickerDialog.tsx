import { useState, useEffect, useCallback, useRef } from "react";
import { Dialog } from "./Dialog";
import { api } from "../lib/api";

interface FileEntry {
  name:  string;
  path:  string;
  isDir: boolean;
}

interface Props {
  open:         boolean;
  title?:       string;
  /** "dir" (default) = only directories selectable; "any" = files too. */
  mode?:        "dir" | "any";
  initialPath?: string;
  onSelect:     (path: string) => void;
  onClose:      () => void;
}

export function PathPickerDialog({
  open,
  title = "Select folder",
  mode = "dir",
  initialPath = "/",
  onSelect,
  onClose,
}: Props) {
  const [cwd,      setCwd]      = useState(initialPath);
  const [entries,  setEntries]  = useState<FileEntry[]>([]);
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState("");
  const [inputVal, setInputVal] = useState(initialPath);

  // Request-sequencing guard: only the most recent browse call updates state.
  const requestIdRef = useRef(0);

  const browse = useCallback(async (path: string) => {
    const id = ++requestIdRef.current;
    setLoading(true);
    setError("");
    try {
      const { data, error: err } = await api.api.files.list.get({ query: { path } });
      if (id !== requestIdRef.current) return; // stale response — discard
      if (err || !data) {
        setError("Cannot read directory");
        return;
      }
      const items = (data as FileEntry[])
        .filter(e => mode === "any" || e.isDir)
        .sort((a, b) => {
          if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
      setEntries(items);
      setCwd(path);
      setInputVal(path);
    } catch {
      if (id !== requestIdRef.current) return;
      setError("Cannot read directory");
    } finally {
      if (id === requestIdRef.current) setLoading(false);
    }
  }, [mode]);

  // Browse initial path on open
  useEffect(() => {
    if (!open) return;
    const startPath = initialPath || "/";
    browse(startPath);
  }, [open, initialPath, browse]);

  /** Navigate up one level. Normalizes trailing slashes first. */
  function goUp() {
    const normalized = cwd.replace(/\/+$/, "") || "/";
    if (normalized === "/") return;
    const parent = normalized.replace(/\/[^/]+$/, "") || "/";
    browse(parent);
  }

  /** Keyboard: enter in path bar → browse typed path. */
  function onInputKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") browse(inputVal.trim() || "/");
  }

  return (
    <Dialog
      open={open}
      title={title}
      onClose={onClose}
      size="md"
      minHeight="480px"
      footer={
        <>
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={() => { onSelect(cwd); onClose(); }}
            className="px-4 py-2 text-sm bg-amber-500 hover:bg-amber-400 text-black font-semibold rounded-lg transition-colors"
          >
            Select
          </button>
        </>
      }
    >
      {/* Path bar */}
      <div className="flex items-center gap-2 mb-3">
        <button
          onClick={goUp}
          disabled={cwd.replace(/\/+$/, "") === "" || cwd === "/"}
          title="Go up"
          className="p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-gray-700 disabled:opacity-30 disabled:cursor-not-allowed transition-colors shrink-0"
        >
          ↑
        </button>
        <input
          value={inputVal}
          onChange={e => setInputVal(e.target.value)}
          onKeyDown={onInputKeyDown}
          className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-white font-mono focus:outline-none focus:border-amber-500"
          spellCheck={false}
        />
        <button
          onClick={() => browse(inputVal.trim() || "/")}
          className="px-3 py-1.5 text-sm bg-gray-700 hover:bg-gray-600 text-white rounded-lg transition-colors shrink-0"
        >
          Go
        </button>
      </div>

      {/* Current path indicator */}
      <p className="text-[10px] text-gray-500 font-mono mb-2 truncate">
        {cwd}
      </p>

      {/* Entry list */}
      <div className="border border-gray-700 rounded-lg overflow-hidden min-h-[300px]">
        {loading && (
          <div className="flex items-center justify-center h-[300px] text-gray-500 text-sm">
            Loading…
          </div>
        )}
        {!loading && error && (
          <div className="flex items-center justify-center h-[300px] text-red-400 text-sm">
            {error}
          </div>
        )}
        {!loading && !error && entries.length === 0 && (
          <div className="flex items-center justify-center h-[300px] text-gray-600 text-sm">
            Empty directory
          </div>
        )}
        {!loading && !error && entries.length > 0 && (
          <ul className="divide-y divide-gray-800 max-h-[300px] overflow-y-auto">
            {entries.map(e => (
              <li key={e.path}>
                {/* div row — avoids nesting <button> inside <button> when Pick is rendered */}
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => {
                    if (e.isDir) browse(e.path);
                    else setInputVal(e.path);
                  }}
                  onKeyDown={ev => {
                    if (ev.key === "Enter" || ev.key === " ") {
                      ev.preventDefault();
                      if (e.isDir) browse(e.path);
                      else setInputVal(e.path);
                    }
                  }}
                  className="w-full text-left flex items-center gap-2.5 px-3 py-2 hover:bg-gray-800 transition-colors group cursor-pointer"
                >
                  <span className="text-base shrink-0 select-none">
                    {e.isDir ? "📁" : "📄"}
                  </span>
                  <span className="text-sm text-gray-200 font-mono truncate flex-1">
                    {e.name}
                  </span>
                  {e.isDir && (
                    <span className="text-gray-600 group-hover:text-gray-400 text-xs shrink-0">
                      →
                    </span>
                  )}
                  {!e.isDir && mode === "any" && (
                    <button
                      type="button"
                      onClick={ev => {
                        ev.stopPropagation();
                        onSelect(e.path);
                        onClose();
                      }}
                      className="text-xs text-amber-500 hover:text-amber-400 shrink-0 px-1"
                    >
                      Pick
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Dialog>
  );
}
