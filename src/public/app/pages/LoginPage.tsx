import React, { useState } from "react";
import { AuthCard } from "../components/AuthCard";
import { Field } from "../components/Field";
import { SubmitButton } from "../components/SubmitButton";
import { ErrorMsg } from "../components/ErrorMsg";
import { api } from "../lib/api";

export function LoginPage({ onSuccess }: { onSuccess: (username: string) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError]       = useState("");
  const [loading, setLoading]   = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const { data, error: err } = await api.api.auth.login.post({ username, password });
      if (err) {
        setError((err.value as { error?: string })?.error ?? "Login failed");
      } else if (data) {
        onSuccess(username);
      }
    } catch {
      setError("Network error — is the server running?");
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthCard title="Sign in">
      <form onSubmit={handleSubmit}>
        <Field label="Username" value={username} onChange={setUsername} />
        <Field label="Password" type="password" value={password} onChange={setPassword} />
        <SubmitButton label="Sign in" loading={loading} />
        {error && <ErrorMsg message={error} />}
      </form>
    </AuthCard>
  );
}
