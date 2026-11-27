import { useId, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { api } from "../../lib/api";
import { useToastStore } from "../../stores/toastStore";
import { INPUT, LABEL, PRIMARY_BUTTON, QUIET_BUTTON } from "./styles";

/**
 * Change the account password: current, new and confirm, inline on the Account page.
 *
 * Inline rather than in a dialog, so a stray click or Escape cannot throw away what was
 * typed. On success the fields are cleared and `onDone` is called; Cancel clears them too.
 */
export function ChangePasswordForm({ onDone, onChanged }: {
  onDone: () => void;
  /** Called only when the password really changed, not on Cancel. */
  onChanged?: () => void;
}) {
  const [current, setCurrent] = useState("");
  const [next,    setNext]    = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy,    setBusy]    = useState(false);
  const [error,   setError]   = useState("");
  // A second Enter while the first request is in flight must not send it again.
  const savingRef = useRef(false);
  const id = useId();

  const reset = () => { setCurrent(""); setNext(""); setConfirm(""); setError(""); };

  const save = async () => {
    if (savingRef.current) return;
    setError("");
    if (next !== confirm) { setError("Passwords do not match"); return; }
    savingRef.current = true;
    setBusy(true);
    try {
      const { error: err } = await api.api.auth.password.put({ currentPassword: current, newPassword: next });
      if (err) {
        setError((err.value as { error?: string })?.error ?? "Server error");
        return;
      }
      useToastStore.getState().push("Password changed. Other sessions and every API key were revoked.", "success");
      reset();
      onChanged?.();
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unexpected error");
    } finally {
      setBusy(false);
      savingRef.current = false;
    }
  };

  const fields = [
    { key: "current", label: "Current password",     value: current, set: setCurrent, autoComplete: "current-password" },
    { key: "next",    label: "New password",         value: next,    set: setNext,    autoComplete: "new-password"     },
    { key: "confirm", label: "Confirm new password", value: confirm, set: setConfirm, autoComplete: "new-password"     },
  ];

  return (
    <form
      className="space-y-3"
      aria-label="Change password"
      onSubmit={e => { e.preventDefault(); void save(); }}
    >
      {fields.map(f => (
        <div key={f.key}>
          <label htmlFor={`${id}-${f.key}`} className={LABEL}>{f.label}</label>
          <input
            id={`${id}-${f.key}`}
            type="password"
            value={f.value}
            autoComplete={f.autoComplete}
            onChange={e => f.set(e.target.value)}
            // Opened by the user's own click, so moving focus into the form is expected.
            autoFocus={f.key === "current"}
            required
            className={INPUT}
          />
        </div>
      ))}
      {error && (
        <p role="alert" className="text-red-400 text-xs bg-red-500/10 border border-red-500/20 rounded-lg p-2">{error}</p>
      )}
      <div className="flex items-center justify-end gap-2">
        <button type="button" onClick={() => { reset(); onDone(); }} disabled={busy} className={QUIET_BUTTON}>
          Cancel
        </button>
        <button type="submit" disabled={busy || !current || !next || !confirm} className={PRIMARY_BUTTON}>
          {busy && <Loader2 size={12} className="animate-spin" />}
          {busy ? "Saving…" : "Change password"}
        </button>
      </div>
    </form>
  );
}
