import { useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { Dialog } from "../../components/Dialog";
import { useToastStore } from "../../stores/toastStore";
import type { Stack } from "./types";

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

  const handlePull = async () => {
    setBusy(true);
    setError("");
    setLog([]);
    setPhase("pulling");

    try {
      const res = await fetch(`/api/compose/stacks/${stack.name}/pull`, { method: "POST" });

      if (!res.ok || !res.body) {
        const d = await res.json().catch(() => ({})) as { error?: string };
        setError(d.error ?? `Server error ${res.status}`);
        setPhase("idle");
        return;
      }

      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split("\n\n");
        buf = parts.pop() ?? "";
        for (const chunk of parts) {
          const line = chunk.startsWith("data: ") ? chunk.slice(6) : chunk;
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line) as { log?: string; ok?: boolean; error?: string };
            if (msg.log !== undefined) {
              setLog(prev => {
                const next = [...prev, msg.log!];
                // Scroll to bottom after state update
                setTimeout(() => {
                  if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
                }, 0);
                return next;
              });
              // Detect phase from log output
              const lower = msg.log.toLowerCase();
              if (lower.includes("pulling") || lower.includes("pull")) setPhase("pulling");
              if (lower.includes("starting") || lower.includes("up -d") || lower.includes("running")) setPhase("deploying");
            } else if (msg.ok) {
              setPhase("done");
              useToastStore.getState().push(`Stack updated: ${stack.meta?.title ?? stack.name}`, "success");
              onUpdated();
              onClose();
              return;
            } else if (msg.error) {
              setError(msg.error);
              setPhase("idle");
              return;
            }
          } catch { /* skip malformed SSE line */ }
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
