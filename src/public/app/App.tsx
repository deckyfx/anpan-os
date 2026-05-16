import React, { useState, useEffect, useRef } from "react";
import { useRouter }        from "./router";
import { SetupPage }        from "./pages/SetupPage";
import { LoginPage }        from "./pages/LoginPage";
import { PasskeySetupPage } from "./pages/PasskeySetupPage";
import { HomePage }         from "./pages/HomePage";
import { FilesPage }        from "./pages/FilesPage";
import { useAuthStore }     from "./stores/authStore";
import { useSystemStore }   from "./stores/systemStore";
import { ToastContainer }   from "./components/Toast";

export function App() {
  const { view, username, checkAuth, login, afterSetup, logout } = useAuthStore();
  const { path, navigate } = useRouter();
  const prevViewRef = useRef<string>("");

  // Lazy-init: run once on first render, no useEffect needed.
  useState(() => {
    void checkAuth();
    void useSystemStore.getState().load();
  });

  // Reload system info whenever the user transitions into the app (after login
  // or passkey auth). The initial load() runs before any session cookie exists
  // and may cache empty/default values with loaded=true.
  useEffect(() => {
    if (view === "app" && prevViewRef.current !== "app") {
      void useSystemStore.getState().reload();
    }
    prevViewRef.current = view;
  }, [view]);

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

  if (path.startsWith("/files"))  return <><FilesPage onNavigate={navigate} /><ToastContainer /></>;

  return <><HomePage username={username} onLogout={logout} onNavigate={navigate} /><ToastContainer /></>;
}
