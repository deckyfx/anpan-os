import React, { useState, useEffect } from "react";
import { AuthCard } from "../components/AuthCard";
import { useAuthStore } from "../stores/authStore";
import { useShallow } from "zustand/react/shallow";
import { browserSupportsWebAuthn } from "@simplewebauthn/browser";

export function PasskeySetupPage() {
  const { registerPasskey, skipPasskeySetup, loginMethods } = useAuthStore(
    useShallow(s => ({
      registerPasskey:  s.registerPasskey,
      skipPasskeySetup: s.skipPasskeySetup,
      loginMethods:     s.loginMethods,
    })),
  );
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState("");
  const [done, setDone]       = useState(false);

  // Skip silently if browser/context doesn't support WebAuthn, or passkey is disabled.
  useEffect(() => {
    if (!browserSupportsWebAuthn() || !loginMethods.passkey) {
      skipPasskeySetup();
    }
  }, [skipPasskeySetup, loginMethods.passkey]);

  if (!browserSupportsWebAuthn() || !loginMethods.passkey) {
    return null;
  }

  async function handleRegister() {
    setError("");
    setLoading(true);
    try {
      await registerPasskey("This device");
      setDone(true);
      // Short delay so the user sees the success state, then go to app.
      setTimeout(() => skipPasskeySetup(), 1200);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Passkey registration failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthCard title="Add a passkey" subtitle="Account created">
      {done ? (
        <div className="flex flex-col items-center gap-3 py-4">
          <span className="text-4xl">✅</span>
          <p className="text-green-400 text-sm font-medium">Passkey registered!</p>
          <p className="text-gray-500 text-xs">Taking you to the dashboard…</p>
        </div>
      ) : (
        <>
          <p className="text-sm text-gray-400 mb-5">
            Use your fingerprint, face, or device PIN to sign in instantly — no password needed next time.
          </p>

          <button
            type="button"
            onClick={handleRegister}
            disabled={loading}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-black text-sm font-semibold transition-colors disabled:opacity-50 mb-3"
          >
            {loading ? (
              <span className="w-4 h-4 border-2 border-black/40 border-t-transparent rounded-full animate-spin" />
            ) : (
              <span className="text-base">🔑</span>
            )}
            {loading ? "Waiting for authenticator…" : "Set up passkey"}
          </button>

          <button
            type="button"
            onClick={skipPasskeySetup}
            disabled={loading}
            className="w-full px-4 py-2 text-sm text-gray-500 hover:text-gray-300 transition-colors disabled:opacity-50"
          >
            Skip for now
          </button>

          {error && (
            <p className="mt-3 text-red-400 text-xs bg-red-500/10 border border-red-500/20 rounded-lg p-2">
              {error}
            </p>
          )}
        </>
      )}
    </AuthCard>
  );
}
