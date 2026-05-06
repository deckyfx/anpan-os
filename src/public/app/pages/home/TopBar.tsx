import React from "react";
import { LogOut } from "lucide-react";

export function TopBar({ username, version, onLogout }: {
  username: string;
  version: string;
  onLogout: () => void;
}) {
  const handleLogout = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    onLogout();
  };

  return (
    <header className="h-12 border-b border-gray-800 px-5 flex items-center justify-between gap-4 shrink-0 bg-gray-950/80 backdrop-blur-sm">
      <div className="flex items-center gap-2.5">
        <span className="text-lg">🍞</span>
        <span className="font-bold text-amber-400 tracking-wide">anpan-os</span>
        <span className="text-xs text-gray-600 font-mono">v{version}</span>
      </div>
      <div className="flex items-center gap-3">
        <span className="text-xs text-gray-400">{username}</span>
        <button
          onClick={handleLogout}
          title="Sign out"
          className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-white transition-colors px-2.5 py-1.5 rounded-lg hover:bg-gray-800"
        >
          <LogOut size={14} />
          Sign out
        </button>
      </div>
    </header>
  );
}
