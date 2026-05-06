import React, { useEffect, useState } from "react";
import type { View, AuthStatus } from "./types";
import { useRouter }   from "./router";
import { SetupPage }   from "./pages/SetupPage";
import { LoginPage }   from "./pages/LoginPage";
import { HomePage }    from "./pages/HomePage";
import { FilesPage }   from "./pages/FilesPage";

export function App() {
  const [view, setView]         = useState<View>("loading");
  const [username, setUsername] = useState("");
  const { path, navigate }      = useRouter();

  useEffect(() => {
    fetch("/api/auth/status")
      .then((r) => r.json() as Promise<AuthStatus>)
      .then(({ initialized, authenticated }) => {
        if (authenticated) {
          setView("app");
        } else if (initialized) {
          setView("login");
        } else {
          setView("setup");
        }
      })
      .catch(() => setView("login"));
  }, []);

  if (view === "loading") {
    return (
      <div className="flex items-center justify-center min-h-screen bg-gray-950">
        <span className="text-gray-600 text-sm">Loading…</span>
      </div>
    );
  }

  if (view === "setup") {
    return (
      <SetupPage
        onSuccess={(u) => { setUsername(u); setView("app"); }}
      />
    );
  }

  if (view === "login") {
    return (
      <LoginPage
        onSuccess={(u) => { setUsername(u); setView("app"); }}
      />
    );
  }

  // Authenticated — render page based on path
  const onLogout = () => { setUsername(""); setView("login"); };

  if (path.startsWith("/files")) {
    return <FilesPage onNavigate={navigate} />;
  }

  return <HomePage username={username} onLogout={onLogout} onNavigate={navigate} />;
}
