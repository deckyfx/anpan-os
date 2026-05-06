import { useState } from "react";
import { Dialog } from "../../components/Dialog";
import type { Stack } from "./types";
import { api } from "../../lib/api";

// Inner component is keyed by stack.name — mounts fresh each time, loads data
// on first render via lazy useState, no useEffect needed.
function DeleteStackDialogInner({ stack, onClose, onDeleted }: {
  stack: Stack;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [hostPaths,    setHostPaths]    = useState<string[]>([]);
  const [pathsLoading, setPathsLoading] = useState(true);
  const [busy,         setBusy]         = useState(false);
  const [error,        setError]        = useState("");

  // Lazy-init: fetch bind paths once on mount, no useEffect needed.
  useState(() => {
    api.api.docker.stacks({ name: stack.name }).binds.get()
      .then(({ data }) => {
        if (data && typeof data === "object" && "paths" in data && Array.isArray((data as { paths: unknown }).paths)) {
          setHostPaths((data as { paths: string[] }).paths);
        }
      })
      .catch(() => {})
      .finally(() => setPathsLoading(false));
  });

  const title = stack.meta?.title ?? stack.name;

  const handleDelete = async () => {
    setBusy(true);
    setError("");
    try {
      const { error: err2 } = await api.api.docker.stacks({ name: stack.name }).delete();
      if (err2) {
        setError((err2.value as { error?: string })?.error ?? "Server error");
        return;
      }
      onDeleted();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      title={`Delete "${title}"`}
      onClose={onClose}
      size="md"
      footer={
        <>
          <button
            onClick={onClose}
            disabled={busy}
            className="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleDelete}
            disabled={busy}
            className="px-4 py-2 text-sm bg-red-600 hover:bg-red-500 text-white font-semibold rounded-lg transition-colors disabled:opacity-50"
          >
            {busy ? "Deleting…" : "Delete Stack"}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        {/* Warning banner */}
        <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3 space-y-2">
          <div className="flex gap-2.5 items-start">
            <span className="text-red-400 text-base leading-none mt-0.5">⚠</span>
            <div className="text-sm">
              <span className="text-red-300 font-semibold">This cannot be undone. </span>
              <span className="text-red-400/80">Permanently removes <span className="font-mono text-red-300">{stack.name}</span>:</span>
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5 pl-6">
            {[
              `${stack.services.length} container${stack.services.length !== 1 ? "s" : ""}`,
              "named volumes",
              "networks",
              "metadata",
            ].map(label => (
              <span key={label} className="text-[11px] px-2 py-0.5 rounded-full bg-red-500/15 border border-red-500/25 text-red-300">
                {label}
              </span>
            ))}
          </div>
        </div>

        {/* Host paths that will remain */}
        <div className="text-sm space-y-1.5">
          <p className="text-gray-400 font-medium text-xs uppercase tracking-widest">
            Host paths — will remain on disk
          </p>
          {pathsLoading ? (
            <p className="text-gray-600 text-xs italic">Scanning bind mounts…</p>
          ) : hostPaths.length === 0 ? (
            <p className="text-gray-600 text-xs italic">No host bind mounts found.</p>
          ) : (
            <ul className="space-y-1">
              {hostPaths.map(p => (
                <li key={p} className="font-mono text-xs text-amber-300/80 bg-gray-800 border border-gray-700 rounded px-2.5 py-1.5 break-all">
                  {p}
                </li>
              ))}
            </ul>
          )}
          {hostPaths.length > 0 && (
            <p className="text-gray-600 text-[11px]">
              These paths are not deleted — remove them manually if no longer needed.
            </p>
          )}
        </div>

        {error && (
          <p className="text-red-400 text-xs bg-red-500/10 border border-red-500/20 rounded-lg p-2">{error}</p>
        )}
      </div>
    </Dialog>
  );
}

export function DeleteStackDialog({ stack, open, onClose, onDeleted }: {
  stack: Stack | null;
  open: boolean;
  onClose: () => void;
  onDeleted: () => void;
}) {
  if (!open || !stack) return null;
  return <DeleteStackDialogInner key={stack.name} stack={stack} onClose={onClose} onDeleted={onDeleted} />;
}
