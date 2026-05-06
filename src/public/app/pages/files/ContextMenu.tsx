import type { ReactNode } from "react";

interface CtxItemProps {
  label:   string;
  icon?:   ReactNode;
  onClick: () => void;
  danger?: boolean;
}

export function CtxItem({ label, icon, onClick, danger = false }: CtxItemProps) {
  return (
    <button
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={`w-full text-left px-3 py-1.5 text-sm hover:bg-gray-700 transition-colors flex items-center gap-2.5 ${
        danger ? "text-red-400 hover:text-red-300" : "text-gray-200"
      }`}
    >
      {icon && (
        <span className={`shrink-0 ${danger ? "text-red-400" : "text-gray-400"}`}>
          {icon}
        </span>
      )}
      {label}
    </button>
  );
}

export function CtxSep() {
  return <div className="my-1 border-t border-gray-700" />;
}
