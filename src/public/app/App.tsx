import React, { useState } from "react";
import { useRouter }        from "./router";
import { SetupPage }        from "./pages/SetupPage";
import { LoginPage }        from "./pages/LoginPage";
import { PasskeySetupPage } from "./pages/PasskeySetupPage";
import { HomePage }         from "./pages/HomePage";
import { FilesPage }        from "./pages/FilesPage";
import { useAuthStore }   from "./stores/authStore";
import { useSystemStore } from "./stores/systemStore";

export function App() {
  const { view, username, checkAuth, login, afterSetup, logout } = useAuthStore();
  const { path, navigate } = useRouter();

  // Lazy-init: run once on first render, no useEffect needed.
  useState(() => {
    void checkAuth();
    void useSystemStore.getState().load();
  });

  if (view === "loading") {
    return (
      <div className="flex items-center justify-center min-h-screen bg-gray-950">
        <span className="text-gray-600 text-sm">Loading…</span>
      </div>
    );
  }

  if (view === "setup")        return <SetupPage onSuccess={(u) => afterSetup(u)} />;
  if (view === "passkeySetup") return <PasskeySetupPage />;
  if (view === "login")        return <LoginPage onSuccess={(u) => login(u)} />; // login is async, returns Promise

  if (path.startsWith("/files"))  return <FilesPage onNavigate={navigate} />;

  return <HomePage username={username} onLogout={logout} onNavigate={navigate} />;
}
