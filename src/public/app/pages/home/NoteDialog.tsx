import { useState } from "react";
import { Dialog } from "../../components/Dialog";
import type { Stack } from "./types";
import { api } from "../../lib/api";

// Inner component receives a guaranteed non-null stack and is keyed by stack.name,
// so React remounts it whenever the target stack changes — no useEffect needed.
function NoteDialogInner({ stack, onClose, onSaved }: {
  stack: Stack;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [note,  setNote]  = useState(stack.meta?.note ?? "");
  const [busy,  setBusy]  = useState(false);
  const [error, setError] = useState("");

  const handleSave = async () => {
    setBusy(true);
    setError("");
    try {
      const { error: err } = await api.api.docker.stacks({ name: stack.name }).patch({ note: note || null });
      if (err) {
        setError((err.value as { error?: string })?.error ?? "Server error");
        return;
      }
      onSaved();
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
      title={`Note — ${stack.meta?.title ?? stack.name}`}
      onClose={onClose}
      size="md"
      footer={
        <>
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors">
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={busy}
            className="px-4 py-2 text-sm bg-amber-500 hover:bg-amber-400 text-black font-semibold rounded-lg transition-colors disabled:opacity-50"
          >
            {busy ? "Saving…" : "Save"}
          </button>
        </>
      }
    >
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Add a note about this stack…"
        rows={10}
        autoFocus
        className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 font-mono focus:outline-none focus:border-amber-500 resize-y"
      />
      {error && (
        <p className="mt-2 text-red-400 text-xs bg-red-500/10 border border-red-500/20 rounded-lg p-2">{error}</p>
      )}
    </Dialog>
  );
}

export function NoteDialog({ stack, open, onClose, onSaved }: {
  stack: Stack | null;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  if (!open || !stack) return null;
  return <NoteDialogInner key={stack.name} stack={stack} onClose={onClose} onSaved={onSaved} />;
}
