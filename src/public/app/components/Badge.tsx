import React from "react";

const variantClasses: Record<string, string> = {
  green:  "bg-green-500/20 text-green-400 border border-green-500/30",
  red:    "bg-red-500/20 text-red-400 border border-red-500/30",
  yellow: "bg-yellow-500/20 text-yellow-400 border border-yellow-500/30",
  gray:   "bg-gray-500/20 text-gray-400 border border-gray-500/30",
};

const dotClasses: Record<string, string> = {
  green:  "bg-green-400",
  red:    "bg-red-400",
  yellow: "bg-yellow-400",
  gray:   "bg-gray-400",
};

export function Badge({ label, variant }: { label: string; variant: "green" | "red" | "yellow" | "gray" }) {
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${variantClasses[variant]}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${dotClasses[variant]}`} />
      {label}
    </span>
  );
}
