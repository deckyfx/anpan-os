import { useState } from "react";
import { Dialog } from "../../components/Dialog";
import type { Stack } from "./types";
import { api } from "../../lib/api";

/** One bind mount, with the server's verdict on whether it may be deleted. */
interface BindInfo {
  path: string;
  deletable: boolean;
  reason?: string;
  bytes?: number | null;
}

function formatBytes(n: number): string {
  if (n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

// Inner component is keyed by stack.name — mounts fresh each time, loads data
// on first render via lazy useState, no useEffect needed.
function DeleteStackDialogInner({ stack, onClose, onDeleted }: {
  stack: Stack;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [binds,        setBinds]        = useState<BindInfo[]>([]);
  const [selected,     setSelected]     = useState<Set<string>>(new Set());
  const [pathsLoading, setPathsLoading] = useState(true);
  const [busy,         setBusy]         = useState(false);
  const [error,        setError]        = useState("");

  // Lazy-init: fetch bind paths once on mount, no useEffect needed.
  useState(() => {
    api.api.docker.stacks({ name: stack.name }).binds.get()
      .then(({ data }) => {
        const payload = data as { binds?: BindInfo[] } | null;
        if (payload?.binds) setBinds(payload.binds);
      })
      .catch(() => {})
      .finally(() => setPathsLoading(false));
  });

  const toggle = (path: string) => setSelected(prev => {
    const next = new Set(prev);
    if (next.has(path)) next.delete(path); else next.add(path);
    return next;
  });

  const title = stack.meta?.title ?? stack.name;

  const handleDelete = async () => {
    setBusy(true);
    setError("");
    try {
      // Only paths the user ticked. The server re-judges every one of them, so this list
      // is a request rather than an authorisation.
      const { error: err2 } = await api.api.docker.stacks({ name: stack.name })
        .delete({ deletePaths: [...selected] });
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
            {busy
              ? "Deleting…"
              : selected.size > 0
                ? `Delete Stack + ${selected.size} path${selected.size === 1 ? "" : "s"}`
                : "Delete Stack"}
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

        {/* Host bind paths — opt in per path, nothing ticked by default */}
        <div className="text-sm space-y-1.5">
          <p className="text-gray-400 font-medium text-xs uppercase tracking-widest">
            Host paths
          </p>
          {pathsLoading ? (
            <p className="text-gray-600 text-xs italic">Scanning bind mounts…</p>
          ) : binds.length === 0 ? (
            <p className="text-gray-600 text-xs italic">No host bind mounts found.</p>
          ) : (
            <ul className="space-y-1">
              {binds.map(b => (
                <li
                  key={b.path}
                  className={`flex items-start gap-2 rounded px-2.5 py-1.5 border text-xs break-all
                    ${b.deletable
                      ? "bg-gray-800 border-gray-700"
                      : "bg-gray-900/60 border-gray-800"}`}
                >
                  {b.deletable ? (
                    <input
                      type="checkbox"
                      checked={selected.has(b.path)}
                      onChange={() => toggle(b.path)}
                      className="mt-0.5 accent-red-500 shrink-0"
                      aria-label={`Delete ${b.path}`}
                    />
                  ) : (
                    // No checkbox at all rather than a disabled one: the path cannot be
                    // deleted here, and offering a control that never works is worse than
                    // offering none.
                    <span className="mt-0.5 w-3 shrink-0" aria-hidden="true" />
                  )}
                  <span className="flex-1 min-w-0">
                    <span className={`font-mono ${b.deletable ? "text-amber-300/80" : "text-gray-500"}`}>
                      {b.path}
                    </span>
                    {b.bytes !== null && b.bytes !== undefined && (
                      <span className="ml-2 text-gray-500 tabular-nums">{formatBytes(b.bytes)}</span>
                    )}
                    {!b.deletable && b.reason && (
                      <span className="block text-[11px] text-gray-600 mt-0.5">{b.reason}</span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {binds.length > 0 && (
            <p className="text-gray-600 text-[11px]">
              {selected.size === 0
                ? "Nothing selected — every path stays on disk."
                : `${selected.size} path${selected.size === 1 ? "" : "s"} will be deleted permanently.`}
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
