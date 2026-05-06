import React, { useState } from "react";
import { AuthCard } from "../components/AuthCard";
import { Field } from "../components/Field";
import { SubmitButton } from "../components/SubmitButton";
import { ErrorMsg } from "../components/ErrorMsg";

export function SetupPage({ onSuccess }: { onSuccess: (username: string) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError]       = useState("");
  const [loading, setLoading]   = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const res = await fetch("/api/auth/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json() as { ok?: boolean; error?: string };
      if (!res.ok) {
        setError(data.error ?? "Setup failed");
      } else {
        onSuccess(username);
      }
    } catch {
      setError("Network error — is the server running?");
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthCard title="Create admin account" subtitle="First-time setup">
      <form onSubmit={handleSubmit}>
        <Field label="Username" value={username} onChange={setUsername} placeholder="admin" />
        <Field label="Password" type="password" value={password} onChange={setPassword}
               placeholder="8+ characters" />
        <p className="text-xs text-gray-500 mb-1">Password must be 8–32 printable characters with no spaces.</p>
        <SubmitButton label="Create account" loading={loading} />
        {error && <ErrorMsg message={error} />}
      </form>
    </AuthCard>
  );
}
