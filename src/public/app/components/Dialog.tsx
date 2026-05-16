import React, { useEffect } from "react";

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
      onClick={(e) => { if (!disableBackdropClose && e.target === e.currentTarget) onClose(); }}
    >
      <div className={`w-full ${SIZE_CLASS[size]} bg-gray-900 border border-gray-700 rounded-xl shadow-2xl flex flex-col max-h-[90vh]`} style={minHeight ? { minHeight } : undefined}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
          <h2 className="text-base font-semibold text-white">{title}</h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white transition-colors text-xl leading-none"
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
