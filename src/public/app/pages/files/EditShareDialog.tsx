import React, { useState } from "react";
import { Dialog } from "../../components/Dialog";
import { useFileStore } from "../../stores/fileStore";
import type { SambaShare } from "./types";

interface Props {
  open:    boolean;
  share:   SambaShare;
  onClose: () => void;
}

function EditShareDialogInner({ share, onClose }: Omit<Props, "open">) {
  const { editShare, setSambaError, sambaError } = useFileStore();

  const [comment,  setComment]  = useState(share.comment);
  const [readOnly, setReadOnly] = useState(share.readOnly);
  const [guestOk,  setGuestOk]  = useState(share.guestOk);
  const [busy,     setBusy]     = useState(false);

  async function handleSubmit() {
    setBusy(true);
    setSambaError("");
    try {
      await editShare(share.name, { comment, readOnly, guestOk });
      if (!useFileStore.getState().sambaError) onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      title={`Edit Share — ${share.name}`}
      size="md"
      disableBackdropClose
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
            disabled={busy}
            onClick={() => void handleSubmit()}
            className="px-4 py-2 rounded-lg text-sm bg-blue-700 hover:bg-blue-600 text-white transition-colors disabled:opacity-40"
          >
            {busy ? "Saving…" : "Save"}
          </button>
        </>
      }
    >
      <div className="space-y-4 py-1">

        <div className="rounded-lg bg-gray-800/60 border border-gray-700 px-3 py-2 space-y-0.5">
          <p className="text-[10px] text-gray-500 uppercase tracking-wide">Name</p>
          <p className="text-sm font-mono text-gray-300">{share.name}</p>
          <p className="text-[10px] text-gray-500 uppercase tracking-wide mt-1.5">Path</p>
          <p className="text-sm font-mono text-gray-400">{share.path}</p>
        </div>

        <div>
          <label className="block text-xs text-gray-400 mb-1">Comment <span className="text-gray-600">(optional)</span></label>
          <input
            autoFocus
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void handleSubmit(); }}
            placeholder="Share description"
            className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 outline-none focus:border-blue-500 transition-colors"
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
        <label className="flex items-center gap-2 text-sm text-gray-400 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={guestOk}
            onChange={(e) => setGuestOk(e.target.checked)}
            className="w-3.5 h-3.5 rounded accent-blue-500"
          />
          Allow guest access (no password required from Windows)
        </label>

      </div>
    </Dialog>
  );
}

export function EditShareDialog({ open, share, onClose }: Props) {
  if (!open) return null;
  return <EditShareDialogInner key={share.name} share={share} onClose={onClose} />;
}
