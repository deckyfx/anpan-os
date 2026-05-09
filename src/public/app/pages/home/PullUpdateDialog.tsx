import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { Dialog } from "../../components/Dialog";
import { api } from "../../lib/api";
import { useToastStore } from "../../stores/toastStore";
import type { Stack } from "./types";

interface SSEMsg { log?: string; ok?: boolean; error?: string }

export function PullUpdateDialog({ stack, open, onClose, onUpdated }: {
  stack: Stack | null;
  open: boolean;
  onClose: () => void;
  onUpdated: () => void;
}) {
  if (!open || !stack) return null;
  return <PullUpdateDialogInner key={stack.name} stack={stack} onClose={onClose} onUpdated={onUpdated} />;
}

function PullUpdateDialogInner({ stack, onClose, onUpdated }: {
  stack: Stack;
  onClose: () => void;
  onUpdated: () => void;
}) {
  const [busy,  setBusy]  = useState(false);
  const [error, setError] = useState("");
  const [log,   setLog]   = useState<string[]>([]);
  const [phase, setPhase] = useState<"idle" | "pulling" | "deploying" | "done">("idle");

  const logRef = useRef<HTMLPreElement | null>(null);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  const handlePull = async () => {
    setBusy(true);
    setError("");
    setLog([]);
    setPhase("pulling");

    try {
      const { data, error: err } = await api.api.compose.stacks({ name: stack.name }).pull.post();
      if (err) {
        setError((err.value as { error?: string })?.error ?? "Request failed");
        setPhase("idle");
        return;
      }
      for await (const event of data!) {
        const m = event.data as SSEMsg;
        if (m.log !== undefined) {
          setLog(prev => [...prev, m.log!]);
          const lower = m.log.toLowerCase();
          if (lower.includes("pulling") || lower.includes("pull")) setPhase("pulling");
          if (lower.includes("starting") || lower.includes("up -d") || lower.includes("running")) setPhase("deploying");
        } else if (m.ok) {
          setPhase("done");
          useToastStore.getState().push(`Stack updated: ${stack.meta?.title ?? stack.name}`, "success");
          onUpdated();
          onClose();
          return;
        } else if (m.error) {
          setError(m.error);
          setPhase("idle");
          return;
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase("idle");
    } finally {
      setBusy(false);
    }
  };

  const phaseLabel = phase === "pulling"
    ? "Pulling images…"
    : phase === "deploying"
      ? "Deploying…"
      : phase === "done"
        ? "Done!"
        : null;

  const footer = (
    <>
      <button onClick={onClose} disabled={busy} className="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors disabled:opacity-50">
        {busy ? "Running…" : "Close"}
      </button>
      {!busy && (
        <button
          onClick={() => void handlePull()}
          className="px-4 py-2 text-sm bg-sky-600 hover:bg-sky-500 text-white font-semibold rounded-lg transition-colors"
        >
          Pull &amp; Update
        </button>
      )}
    </>
  );

  return (
    <Dialog
      open
      title={`Pull Update — ${stack.meta?.title ?? stack.name}`}
      onClose={onClose}
      size="lg"
      notification={error ? (
        <p className="text-red-400 text-sm bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
          {error}
        </p>
      ) : undefined}
      footer={footer}
    >
      <div className="space-y-3">
        {!busy && log.length === 0 && (
          <p className="text-sm text-gray-400">
            Pull the latest images for <span className="text-white font-medium">{stack.meta?.title ?? stack.name}</span> and re-deploy the stack.
          </p>
        )}

        {phaseLabel && (
          <div className="flex items-center gap-2 text-sm text-gray-300">
            {phase !== "done" && <Loader2 size={14} className="animate-spin text-sky-400 shrink-0" />}
            {phaseLabel}
          </div>
        )}

        {log.length > 0 && (
          <pre
            ref={logRef}
            className="h-64 bg-black rounded-lg border border-gray-700 p-3 text-xs text-green-400 font-mono overflow-y-auto whitespace-pre-wrap"
          >
            {log.join("\n")}
          </pre>
        )}
      </div>
    </Dialog>
  );
}
