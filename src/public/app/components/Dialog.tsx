import React, { useEffect, useId, useRef } from "react";

interface DialogProps {
  open: boolean;
  title: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  /** Rendered between scrollable body and footer — always visible, not scrolled. */
  notification?: React.ReactNode;
  onClose: () => void;
  /** "md" (default, max-w-lg) | "lg" (max-w-3xl) | "xl" (max-w-5xl) | "2xl" (max-w-7xl) */
  size?: "md" | "lg" | "xl" | "2xl";
  /** Optional minimum height for the dialog panel, e.g. "600px" */
  minHeight?: string;
  /** When true, clicking the backdrop does not close the dialog. */
  disableBackdropClose?: boolean;
}

const SIZE_CLASS: Record<NonNullable<DialogProps["size"]>, string> = {
  md:  "max-w-lg",
  lg:  "max-w-3xl",
  xl:  "max-w-5xl",
  "2xl": "max-w-7xl",
};

export function Dialog({ open, title, children, footer, notification, onClose, size = "md", minHeight, disableBackdropClose = false }: DialogProps) {
  const titleId = useId();
  // Whether the current press started on the backdrop itself. A click is dispatched to the
  // nearest common ancestor of press and release, so selecting text in a field and letting
  // go outside the panel used to "click" the backdrop and close the dialog, input and all.
  const pressedOnBackdrop = useRef(false);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onPointerDown={(e) => { pressedOnBackdrop.current = e.target === e.currentTarget; }}
      onClick={(e) => {
        // Both the press and the release must land on the backdrop.
        const fromBackdrop = pressedOnBackdrop.current;
        pressedOnBackdrop.current = false;
        if (!disableBackdropClose && fromBackdrop && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={`w-full ${SIZE_CLASS[size]} bg-gray-900 border border-gray-700 rounded-xl shadow-2xl flex flex-col max-h-[90vh]`}
        style={minHeight ? { minHeight } : undefined}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
          <h2 id={titleId} className="text-base font-semibold text-white">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="min-h-6 min-w-6 pointer-coarse:min-h-11 pointer-coarse:min-w-11 flex items-center justify-center text-gray-400 hover:text-white transition-colors text-xl leading-none"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="px-5 py-4 overflow-y-auto flex-1">
          {children}
        </div>

        {notification && (
          <div className="px-5 py-3 border-t border-gray-800/60">
            {notification}
          </div>
        )}

        {footer && (
          <div className="px-5 py-4 border-t border-gray-800 flex justify-end gap-2">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
