import React, { useState } from "react";
import { AuthCard }    from "../components/AuthCard";
import { Field }       from "../components/Field";
import { SubmitButton } from "../components/SubmitButton";
import { ErrorMsg }    from "../components/ErrorMsg";
import { api }         from "../lib/api";
import { useAuthStore } from "../stores/authStore";
import { useShallow } from "zustand/react/shallow";
import { browserSupportsWebAuthn } from "@simplewebauthn/browser";

const webAuthnSupported = browserSupportsWebAuthn();

/** Login screen supporting password form and/or passkey sign-in based on server-configured methods. */
export function LoginPage({ onSuccess }: { onSuccess: (username: string) => Promise<void> }) {
  const { loginWithPasskey, loginMethods } = useAuthStore(
    useShallow(s => ({ loginWithPasskey: s.loginWithPasskey, loginMethods: s.loginMethods })),
  );

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError]       = useState("");
  const [loading, setLoading]   = useState(false);
  const [pkLoading, setPkLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const { data, error: err } = await api.api.auth.login.post({ username, password });
      if (err) setError((err.value as { error?: string })?.error ?? "Login failed");
      else if (data) await onSuccess(username);
    } catch {
      setError("Network error — is the server running?");
    } finally {
      setLoading(false);
    }
  }

  async function handlePasskey() {
    setError("");
    setPkLoading(true);
    try {
      await loginWithPasskey();
      // loginWithPasskey sets view to "app" in the store; onSuccess not needed.
    } catch (err) {
      setError(err instanceof Error ? err.message : "Passkey sign-in failed");
    } finally {
      setPkLoading(false);
    }
  }

  const showForm    = loginMethods.form;
  const showPasskey = loginMethods.passkey && webAuthnSupported;

  if (!showForm && !showPasskey) {
    return (
      <AuthCard title="Sign in">
        <p className="text-sm text-gray-400 text-center py-4">
          Login is currently disabled by the administrator.
        </p>
      </AuthCard>
    );
  }

  return (
    <AuthCard title="Sign in">
      {showForm && (
        <form onSubmit={handleSubmit}>
          <Field label="Username" value={username} onChange={setUsername} />
          <Field label="Password" type="password" value={password} onChange={setPassword} />
          <SubmitButton label="Sign in" loading={loading} />
          {error && <ErrorMsg message={error} />}
        </form>
      )}

      {showPasskey && (
        <>
          {showForm && (
            <div className="flex items-center gap-3 my-5">
              <div className="flex-1 h-px bg-gray-800" />
              <span className="text-xs text-gray-500">or</span>
              <div className="flex-1 h-px bg-gray-800" />
            </div>
          )}

          <button
            type="button"
            onClick={handlePasskey}
            disabled={pkLoading || loading}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg border border-gray-700 bg-gray-800 hover:bg-gray-700 text-sm text-gray-200 font-medium transition-colors disabled:opacity-50"
          >
            {pkLoading ? (
              <span className="w-4 h-4 border-2 border-gray-400 border-t-transparent rounded-full animate-spin" />
            ) : (
              <span className="text-base">🔑</span>
            )}
            {pkLoading ? "Waiting for authenticator…" : "Sign in with passkey"}
          </button>

          {!showForm && error && <ErrorMsg message={error} />}
        </>
      )}
    </AuthCard>
  );
}
