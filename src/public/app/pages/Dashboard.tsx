import React from "react";

export function Dashboard({ username, onLogout }: { username: string; onLogout: () => void }) {
  async function handleLogout() {
    await fetch("/api/auth/logout", { method: "POST" });
    onLogout();
  }

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <header className="border-b border-gray-800 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xl">🍞</span>
          <span className="font-bold text-amber-400">anpan-os</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-sm text-gray-400">{username}</span>
          <button
            onClick={handleLogout}
            className="text-sm text-gray-400 hover:text-white transition-colors"
          >
            Sign out
          </button>
        </div>
      </header>

      <main className="flex items-center justify-center h-[calc(100vh-64px)]">
        <p className="text-gray-500 text-sm">Dashboard coming soon…</p>
      </main>
    </div>
  );
}
