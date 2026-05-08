import { useState, useRef } from "react";
import { Dialog } from "../../components/Dialog";
import { api } from "../../lib/api";
import { useToastStore } from "../../stores/toastStore";

export function ChangePasswordDialog({ open, onClose }: {
  open: boolean;
  onClose: () => void;
}) {
  if (!open) return null;
  return <ChangePasswordDialogInner onClose={onClose} />;
}

function ChangePasswordDialogInner({ onClose }: { onClose: () => void }) {
  const [current, setCurrent]   = useState("");
  const [next,    setNext]      = useState("");
  const [confirm, setConfirm]   = useState("");
  const [busy,    setBusy]      = useState(false);
  const [error,   setError]     = useState("");
  const savingRef = useRef(false);

  const handleSave = async () => {
    if (savingRef.current) return;
    savingRef.current = true;
    setError("");
    if (next !== confirm) { setError("Passwords do not match"); savingRef.current = false; return; }
    setBusy(true);
    try {
      const { error: err } = await api.api.auth.password.put({
        currentPassword: current,
        newPassword:     next,
      });
      if (err) {
        setError((err.value as { error?: string })?.error ?? "Server error");
        return;
      }
      useToastStore.getState().push("Password changed", "success");
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unexpected error");
    } finally {
      setBusy(false);
      savingRef.current = false;
    }
  };

  const footer = (
    <>
      <button onClick={onClose} className="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors">
        Cancel
      </button>
      <button
        onClick={() => { if (!savingRef.current) void handleSave(); }}
        disabled={busy}
        className="px-4 py-2 text-sm bg-amber-500 hover:bg-amber-400 text-black font-semibold rounded-lg transition-colors disabled:opacity-50"
      >
        {busy ? "Saving…" : "Change Password"}
      </button>
    </>
  );

  return (
    <Dialog open title="Change Password" onClose={onClose} footer={footer}>
      <div className="space-y-3">
        {[
          { label: "Current password", value: current, set: setCurrent, autoComplete: "current-password" },
          { label: "New password",     value: next,    set: setNext,    autoComplete: "new-password"     },
          { label: "Confirm new",      value: confirm, set: setConfirm, autoComplete: "new-password"     },
        ].map(({ label, value, set, autoComplete }) => (
          <div key={label}>
            <label className="block text-xs text-gray-500 mb-1">{label}</label>
            <input
              type="password"
              value={value}
              autoComplete={autoComplete}
              onChange={(e) => set(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !busy && !savingRef.current && void handleSave()}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-amber-500"
            />
          </div>
        ))}
        {error && (
          <p className="text-red-400 text-xs bg-red-500/10 border border-red-500/20 rounded-lg p-2">{error}</p>
        )}
      </div>
    </Dialog>
  );
}
