import { useEffect, useId, useRef, useState } from "react";
import { Loader2, LogIn, LogOut } from "lucide-react";
import { api } from "../../lib/api";
import { useToastStore } from "../../stores/toastStore";
import { INPUT, LABEL, PRIMARY_BUTTON, QUIET_BUTTON } from "./styles";

interface Status { loggedIn: boolean; username: string | null }

/**
 * Docker Hub sign-in for the host's Docker daemon, inline on the Account page.
 *
 * Shows who is signed in with a Sign out button, or a username and password (or access
 * token) form. Signing in raises Docker Hub's pull rate limits and gives access to the
 * account's private images.
 */
export function DockerHubForm() {
  const [status,   setStatus]   = useState<Status | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy,     setBusy]     = useState(false);
  const [error,    setError]    = useState("");
  const loadIdRef = useRef(0);
  const id = useId();

  useEffect(() => {
    const loadId = ++loadIdRef.current;
    void (async () => {
      try {
        const { data } = await api.api.auth.dockerhub.get();
        if (loadId !== loadIdRef.current) return;
        const s = (data as Status | null) ?? { loggedIn: false, username: null };
        setStatus(s);
        if (s.username) setUsername(s.username);
      } catch {
        if (loadId === loadIdRef.current) setStatus({ loggedIn: false, username: null });
      }
    })();
  }, []);

  const signIn = async () => {
    if (busy || !username || !password) return;
    setError("");
    setBusy(true);
    try {
      const { data, error: err } = await api.api.auth.dockerhub.post({ username, password });
      if (err) {
        setError((err.value as { error?: string })?.error ?? "Login failed");
        return;
      }
      if (data) {
        ++loadIdRef.current;
        setStatus({ loggedIn: true, username });
        setPassword("");
        useToastStore.getState().push("Signed in to Docker Hub", "success");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Login failed");
    } finally {
      setBusy(false);
    }
  };

  const signOut = async () => {
    setError("");
    setBusy(true);
    try {
      const { error: err } = await api.api.auth.dockerhub.delete();
      if (err) {
        setError((err.value as { error?: string })?.error ?? "Logout failed");
        return;
      }
      ++loadIdRef.current;
      setStatus({ loggedIn: false, username: null });
      setUsername("");
      useToastStore.getState().push("Signed out from Docker Hub", "success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Logout failed");
    } finally {
      setBusy(false);
    }
  };

  const errorBox = error
    ? <p role="alert" className="text-red-400 text-xs bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">{error}</p>
    : null;

  if (status === null) {
    return (
      <p className="flex items-center gap-2 text-xs text-gray-500">
        <Loader2 size={13} className="animate-spin" /> Checking…
      </p>
    );
  }

  if (status.loggedIn) {
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-3 flex-wrap p-3 bg-green-500/10 border border-green-500/20 rounded-lg">
          <div className="flex-1 min-w-0">
            <p className="text-sm text-green-400 font-medium">Signed in</p>
            <p className="text-xs text-gray-400 mt-0.5">Username: <span className="font-mono text-white">{status.username}</span></p>
          </div>
          <button type="button" onClick={() => void signOut()} disabled={busy} className={QUIET_BUTTON}>
            {busy ? <Loader2 size={12} className="animate-spin" /> : <LogOut size={12} />}
            Sign out of Docker Hub
          </button>
        </div>
        {errorBox}
      </div>
    );
  }

  return (
    <form className="space-y-3" aria-label="Sign in to Docker Hub" onSubmit={e => { e.preventDefault(); void signIn(); }}>
      <div>
        <label htmlFor={`${id}-user`} className={LABEL}>Username</label>
        <input
          id={`${id}-user`}
          type="text"
          value={username}
          onChange={e => setUsername(e.target.value)}
          placeholder="dockerhub username"
          autoComplete="username"
          spellCheck={false}
          className={INPUT}
        />
      </div>
      <div>
        <label htmlFor={`${id}-pass`} className={LABEL}>Password or access token</label>
        <input
          id={`${id}-pass`}
          type="password"
          value={password}
          onChange={e => setPassword(e.target.value)}
          placeholder="password or access token"
          autoComplete="current-password"
          aria-describedby={`${id}-hint`}
          className={INPUT}
        />
        <p id={`${id}-hint`} className="text-[11px] text-gray-500 mt-1.5">A read-only access token is the safer choice.</p>
      </div>
      {errorBox}
      <div className="flex justify-end">
        <button type="submit" disabled={busy || !username || !password} className={PRIMARY_BUTTON}>
          {busy ? <Loader2 size={12} className="animate-spin" /> : <LogIn size={12} />}
          Sign in
        </button>
      </div>
    </form>
  );
}
