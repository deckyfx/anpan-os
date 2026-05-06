import React, { useState } from "react";
import { useRouter }   from "./router";
import { SetupPage }   from "./pages/SetupPage";
import { LoginPage }   from "./pages/LoginPage";
import { HomePage }    from "./pages/HomePage";
import { FilesPage }   from "./pages/FilesPage";
import { useAuthStore } from "./stores/authStore";

export function App() {
  const { view, username, checkAuth, login, logout } = useAuthStore();
  const { path, navigate } = useRouter();

  // Lazy-init: run once on first render, no useEffect needed.
  useState(() => { void checkAuth(); });

  if (view === "loading") {
    return (
      <div className="flex items-center justify-center min-h-screen bg-gray-950">
        <span className="text-gray-600 text-sm">Loading…</span>
      </div>
    );
  }

  if (view === "setup") {
    return <SetupPage onSuccess={(u) => login(u)} />;
  }

  if (view === "login") {
    return <LoginPage onSuccess={(u) => login(u)} />;
  }

  if (path.startsWith("/files")) {
    return <FilesPage onNavigate={navigate} />;
  }

  return <HomePage username={username} onLogout={logout} onNavigate={navigate} />;
}
