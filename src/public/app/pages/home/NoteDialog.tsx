import React, { useEffect, useState } from "react";
import { Dialog } from "../../components/Dialog";
import type { Stack } from "./types";

export function NoteDialog({ stack, open, onClose, onSaved }: {
  stack: Stack | null;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [note,  setNote]  = useState("");
  const [busy,  setBusy]  = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (stack) setNote(stack.meta?.note ?? "");
  }, [stack?.meta?.note, stack?.name]);

  if (!stack) return null;

  const handleSave = async () => {
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/docker/stacks/${encodeURIComponent(stack.name)}`, {
        method:  "PATCH",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ note: note || null }),
      });
      if (!res.ok) {
        const d = await res.json() as { error?: string };
        setError(d.error ?? `Server error ${res.status}`);
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
      open={open}
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
