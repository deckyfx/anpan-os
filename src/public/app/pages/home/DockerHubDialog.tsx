import { useState, useEffect } from "react";
import { Loader2, LogIn, LogOut, ContainerIcon } from "lucide-react";
import { Dialog } from "../../components/Dialog";
import { api } from "../../lib/api";
import { useToastStore } from "../../stores/toastStore";

interface Status { loggedIn: boolean; username: string | null }

export function DockerHubDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  return <DockerHubDialogInner onClose={onClose} />;
}

function DockerHubDialogInner({ onClose }: { onClose: () => void }) {
  const [status,   setStatus]   = useState<Status | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy,     setBusy]     = useState(false);
  const [error,    setError]    = useState("");

  useEffect(() => {
    void (async () => {
      try {
        const { data } = await api.api.auth.dockerhub.get();
        setStatus(data as Status);
        if ((data as Status).username) setUsername((data as Status).username ?? "");
      } catch { setStatus({ loggedIn: false, username: null }); }
    })();
  }, []);

  const handleLogin = async () => {
    if (busy) return;
    setError("");
    setBusy(true);
    try {
      const { data, error: err } = await api.api.auth.dockerhub.post({ username, password });
      if (err) {
        setError((err.value as { error?: string })?.error ?? "Login failed");
        return;
      }
      if (data) {
        setStatus({ loggedIn: true, username });
        setPassword("");
        useToastStore.getState().push("Signed in to Docker Hub", "success");
      }
    } finally {
      setBusy(false);
    }
  };

  const handleLogout = async () => {
    setError("");
    setBusy(true);
    try {
      await api.api.auth.dockerhub.delete();
      setStatus({ loggedIn: false, username: null });
      setUsername("");
      useToastStore.getState().push("Signed out from Docker Hub", "success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Logout failed");
    } finally {
      setBusy(false);
    }
  };

  const errorNotif = error ? (
    <p className="text-red-400 text-sm bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">{error}</p>
  ) : undefined;

  const footer = status?.loggedIn ? (
    <div className="flex items-center gap-2 w-full">
      <div className="flex-1" />
      <button type="button" onClick={onClose} disabled={busy} className="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors">Close</button>
      <button
        type="button"
        onClick={() => void handleLogout()}
        disabled={busy}
        className="px-4 py-2 text-sm bg-red-600 hover:bg-red-500 text-white font-semibold rounded-lg transition-colors disabled:opacity-50 flex items-center gap-1.5"
      >
        {busy ? <Loader2 size={13} className="animate-spin" /> : <LogOut size={13} />}
        Sign out
      </button>
    </div>
  ) : (
    <div className="flex items-center gap-2 w-full">
      <div className="flex-1" />
      <button type="button" onClick={onClose} disabled={busy} className="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors">Cancel</button>
      <button
        type="button"
        onClick={() => void handleLogin()}
        disabled={busy || !username || !password}
        className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 text-white font-semibold rounded-lg transition-colors disabled:opacity-50 flex items-center gap-1.5"
      >
        {busy ? <Loader2 size={13} className="animate-spin" /> : <LogIn size={13} />}
        Sign in
      </button>
    </div>
  );

  return (
    <Dialog open title="Docker Hub" disableBackdropClose onClose={onClose} size="md" notification={errorNotif} footer={footer}>
      <div className="space-y-5">
        <div className="flex items-center gap-3 p-3 bg-gray-800/50 rounded-lg border border-gray-700">
          <ContainerIcon size={20} className="text-blue-400 shrink-0" />
          <div>
            <p className="text-sm text-white font-medium">Docker Hub Authentication</p>
            <p className="text-xs text-gray-500 mt-0.5">Sign in to increase rate limits and access private images</p>
          </div>
        </div>

        {status === null && (
          <div className="flex items-center justify-center h-24 text-gray-600 text-sm">
            <Loader2 size={16} className="animate-spin mr-2" /> Loading…
          </div>
        )}

        {status?.loggedIn && (
          <div className="p-4 bg-green-500/10 border border-green-500/20 rounded-lg">
            <p className="text-sm text-green-400 font-medium">Signed in</p>
            <p className="text-xs text-gray-400 mt-1">Username: <span className="font-mono text-white">{status.username}</span></p>
          </div>
        )}

        {status && !status.loggedIn && (
          <div className="space-y-4">
            <div>
              <label className="block text-[10px] font-semibold text-gray-500 uppercase tracking-widest mb-1.5">Username</label>
              <input
                type="text"
                value={username}
                onChange={e => setUsername(e.target.value)}
                placeholder="dockerhub username"
                autoComplete="username"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500"
              />
            </div>
            <div>
              <label className="block text-[10px] font-semibold text-gray-500 uppercase tracking-widest mb-1.5">
                Password / Access Token
              </label>
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="password or access token"
                autoComplete="current-password"
                onKeyDown={e => { if (e.key === "Enter" && username && password && !busy) void handleLogin(); }}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500"
              />
              <p className="text-[10px] text-gray-600 mt-1.5">Use a read-only access token for better security</p>
            </div>
          </div>
        )}
      </div>
    </Dialog>
  );
}
