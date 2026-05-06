import React, { useEffect } from "react";

interface DrawerProps {
  open: boolean;
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}

export function Drawer({ open, title, children, onClose }: DrawerProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  return (
    <>
      {/* Overlay */}
      <div
        className={`fixed inset-0 z-40 bg-black/50 backdrop-blur-sm transition-opacity duration-200 ${open ? "opacity-100" : "opacity-0 pointer-events-none"}`}
        onClick={onClose}
      />

      {/* Panel */}
      <div
        className={`fixed top-0 right-0 z-50 h-full w-full max-w-lg bg-gray-900 border-l border-gray-800 shadow-2xl flex flex-col transition-transform duration-200 ${open ? "translate-x-0" : "translate-x-full"}`}
      >
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
        <div className="flex-1 overflow-y-auto p-4">
          {children}
        </div>
      </div>
    </>
  );
}
