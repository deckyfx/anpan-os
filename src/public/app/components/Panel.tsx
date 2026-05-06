import React from "react";

export function Panel({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`bg-gray-900 border border-gray-800 rounded-xl p-4 ${className}`}>
      {children}
    </div>
  );
}
