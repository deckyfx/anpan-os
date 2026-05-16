import React, { useState } from "react";
import { Dialog } from "../../components/Dialog";
import { useFileStore } from "../../stores/fileStore";

interface Props {
  open:         boolean;
  onClose:      () => void;
  initialName?: string;
  initialPath?: string;
}

function AddShareDialogInner({
  onClose, initialName = "", initialPath = "",
}: Omit<Props, "open"> & { initialName: string; initialPath: string }) {
  const { addShare, setNewShare, setSambaError, sambaError, loadShares } = useFileStore();

  const [name,     setName]     = useState(initialName);
  const [path,     setPath]     = useState(initialPath);
  const [readOnly, setReadOnly] = useState(false);
  const [busy,     setBusy]     = useState(false);

  const nameValid = !name || /^[a-zA-Z0-9_\-]+$/.test(name);
  const canSubmit = !!name.trim() && !!path.trim() && nameValid && !busy;

  async function handleSubmit() {
    if (!canSubmit) return;
    setBusy(true);
    setSambaError("");
    setNewShare({ name, path, comment: "", readOnly });
    try {
      await addShare();
      await loadShares();
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      title="Add Share"
      size="md"
      onClose={onClose}
      notification={sambaError ? <p className="text-xs text-red-400">{sambaError}</p> : undefined}
      footer={
        <>
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-sm text-gray-300 hover:text-white hover:bg-gray-800 transition-colors"
          >
            Cancel
          </button>
          <button
            disabled={!canSubmit}
            onClick={() => void handleSubmit()}
            className="px-4 py-2 rounded-lg text-sm bg-green-700 hover:bg-green-600 text-white transition-colors disabled:opacity-40"
          >
            {busy ? "Adding…" : "Add Share"}
          </button>
        </>
      }
    >
      <div className="space-y-4 py-1">
        <div>
          <label className="block text-xs text-gray-400 mb-1">Share name</label>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void handleSubmit(); }}
            placeholder="my-share"
            className={`w-full bg-gray-900 border rounded px-3 py-2 text-sm font-mono text-gray-200 outline-none transition-colors ${
              !nameValid ? "border-red-500 focus:border-red-400" : "border-gray-700 focus:border-blue-500"
            }`}
          />
          {!nameValid && (
            <p className="text-[10px] text-red-400 mt-1">Letters, numbers, hyphens, underscores only</p>
          )}
        </div>

        <div>
          <label className="block text-xs text-gray-400 mb-1">Path</label>
          <input
            value={path}
            onChange={(e) => setPath(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void handleSubmit(); }}
            placeholder="/path/to/folder"
            className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm font-mono text-gray-200 outline-none focus:border-blue-500 transition-colors"
          />
        </div>

        <label className="flex items-center gap-2 text-sm text-gray-400 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={readOnly}
            onChange={(e) => setReadOnly(e.target.checked)}
            className="w-3.5 h-3.5 rounded accent-blue-500"
          />
          Read-only
        </label>
      </div>
    </Dialog>
  );
}

export function AddShareDialog({ open, onClose, initialName = "", initialPath = "" }: Props) {
  if (!open) return null;
  return (
    <AddShareDialogInner
      key={`${initialName}:${initialPath}`}
      onClose={onClose}
      initialName={initialName}
      initialPath={initialPath}
    />
  );
}
