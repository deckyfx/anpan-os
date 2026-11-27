import { useRef, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { DANGER_BUTTON, QUIET_BUTTON } from "./styles";

/**
 * A destructive action with an inline second step.
 *
 * The first button never moves. Pressed, it turns into Cancel and keeps the focus, and the
 * destructive button appears to its left, in space that was reserved for it all along
 * (`visibility: hidden` until then, so it is not in the tab order or the accessibility
 * tree either). A double click therefore lands on Cancel, never on the destructive
 * button, and nothing around it reflows. Escape also cancels.
 *
 * @param subject - What is acted on, for accessible names, e.g. "key backup-script"
 */
export function InlineConfirm({ label, icon, confirmLabel, busyLabel, subject, confirming, busy, disabled, onAsk, onCancel, onConfirm }: {
  label: string;
  icon?: ReactNode;
  confirmLabel: string;
  busyLabel: string;
  subject: string;
  confirming: boolean;
  busy: boolean;
  disabled?: boolean;
  onAsk: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const slotRef = useRef<HTMLButtonElement>(null);

  return (
    <div
      className="inline-flex items-center gap-1.5"
      onKeyDown={e => { if (confirming && !busy && e.key === "Escape") { e.stopPropagation(); onCancel(); slotRef.current?.focus(); } }}
    >
      <button
        type="button"
        onClick={onConfirm}
        disabled={busy || !confirming}
        aria-hidden={confirming ? undefined : true}
        tabIndex={confirming ? undefined : -1}
        className={`${DANGER_BUTTON} ${confirming ? "" : "invisible"}`}
      >
        {busy && <Loader2 size={12} className="animate-spin" />}
        {busy ? busyLabel : confirmLabel}
      </button>
      <button
        ref={slotRef}
        type="button"
        onClick={() => {
          if (confirming) onCancel(); else onAsk();
          // Safari does not focus a clicked button; make sure the safe action has focus.
          slotRef.current?.focus();
        }}
        disabled={busy || (disabled && !confirming)}
        aria-label={confirming ? `Cancel: keep ${subject}` : `${label} ${subject}`}
        className={`${QUIET_BUTTON} w-24 ${confirming ? "" : "hover:text-red-300"}`}
      >
        {!confirming && icon}
        {confirming ? "Cancel" : label}
      </button>
    </div>
  );
}
