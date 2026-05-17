import { useState } from "react";
import { Dialog } from "../../components/Dialog";
import type { Stack } from "./types";
import { api } from "../../lib/api";

// ─── Generic note-target shape ────────────────────────────────────────────────

export interface NoteTarget {
  label: string;
  initialNote: string;
  /** Called with the new note text (empty string = clear). */
  onSave: (note: string) => Promise<{ error?: unknown }>;
}

// ─── Inner (always has a non-null target) ─────────────────────────────────────

function NoteDialogInner({ target, onClose, onSaved }: {
  target: NoteTarget;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [note,  setNote]  = useState(target.initialNote);
  const [busy,  setBusy]  = useState(false);
  const [error, setError] = useState("");

  const handleSave = async () => {
    setBusy(true);
    setError("");
    try {
      const result = await target.onSave(note);
      if (result.error) {
        setError((result.error as { error?: string })?.error ?? "Server error");
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
      title={`Note — ${target.label}`}
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
        onChange={e => setNote(e.target.value)}
        placeholder="Add a note…"
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

// ─── Stack convenience wrapper (backwards-compatible) ─────────────────────────

export function NoteDialog({ stack, open, onClose, onSaved }: {
  stack: Stack | null;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  if (!open || !stack) return null;
  const target: NoteTarget = {
    label:       stack.meta?.title ?? stack.name,
    initialNote: stack.meta?.note ?? "",
    onSave: async (note) => {
      const { error } = await api.api.docker.stacks({ name: stack.name }).patch({ note: note || null });
      return { error };
    },
  };
  return (
    <NoteDialogInner key={stack.name} target={target} onClose={onClose} onSaved={onSaved} />
  );
}

// ─── Generic wrapper ──────────────────────────────────────────────────────────

export function GenericNoteDialog({ target, open, onClose, onSaved }: {
  target: NoteTarget | null;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  if (!open || !target) return null;
  return (
    <NoteDialogInner key={target.label} target={target} onClose={onClose} onSaved={onSaved} />
  );
}
