import { useEffect, useRef, useState } from "react";
import { Loader2, ArrowRightLeft } from "lucide-react";
import { Dialog } from "../../components/Dialog";
import { api } from "../../lib/api";
import { useToastStore } from "../../stores/toastStore";
import type { Stack } from "./types";

interface MigrateMsg {
  step?: "reading" | "writing" | "deploying";
  log?: string;
  ok?: true;
  error?: string;
  needPath?: true;
}

type Phase = "idle" | "reading" | "writing" | "deploying" | "needPath" | "done" | "error";

export function MigrateCasaosDialog({ stack, open, onClose, onDone }: {
  stack: Stack | null;
  open: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  if (!open || !stack) return null;
  return <MigrateCasaosDialogInner key={stack.name} stack={stack} onClose={onClose} onDone={onDone} />;
}

function MigrateCasaosDialogInner({ stack, onClose, onDone }: {
  stack: Stack;
  onClose: () => void;
  onDone: () => void;
}) {
  const defaultPath = `/var/lib/casaos/apps/${stack.name}/docker-compose.yml`;

  const [phase,       setPhase]       = useState<Phase>("idle");
  const [log,         setLog]         = useState<string[]>([]);
  const [errorMsg,    setErrorMsg]    = useState("");
  const [composePath, setComposePath] = useState(defaultPath);

  const logRef = useRef<HTMLPreElement | null>(null);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  const busy = phase === "reading" || phase === "writing" || phase === "deploying";

  const runMigration = async (path?: string) => {
    setLog([]);
    setErrorMsg("");

    try {
      const { data, error: err } = await api.api.casaos.migrate({ name: stack.name }).post(
        path ? { composePath: path } : {},
      );
      if (err) {
        setErrorMsg((err.value as { error?: string })?.error ?? "Request failed");
        setPhase("error");
        return;
      }

      for await (const event of data as AsyncIterable<{ data: MigrateMsg }>) {
        const m = event.data as MigrateMsg;

        if (m.step) {
          setPhase(m.step);
        } else if (m.log !== undefined) {
          setLog(prev => [...prev, m.log!]);
        } else if (m.ok) {
          setPhase("done");
          useToastStore.getState().push(
            `Migrated ${stack.meta?.title ?? stack.name} to anpan-os`,
            "success",
          );
          onDone();
          return;
        } else if (m.error) {
          setErrorMsg(m.error);
          setPhase(m.needPath ? "needPath" : "error");
          return;
        }
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setPhase("error");
    }
  };

  const phaseLabel: Record<Phase, string | null> = {
    idle:      null,
    reading:   "Reading compose file…",
    writing:   "Writing to anpan-os folder…",
    deploying: "Deploying stack…",
    needPath:  null,
    done:      "Migration complete ✓",
    error:     null,
  };

  // ─── Footer ──────────────────────────────────────────────────────────────────

  const footer = (() => {
    if (phase === "idle") return (
      <>
        <button onClick={onClose} className="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors">
          Cancel
        </button>
        <button
          onClick={() => void runMigration()}
          className="px-4 py-2 text-sm bg-sky-600 hover:bg-sky-500 text-white font-semibold rounded-lg transition-colors flex items-center gap-2"
        >
          <ArrowRightLeft size={14} />
          Start Migration
        </button>
      </>
    );

    if (phase === "needPath") return (
      <button
        onClick={() => void runMigration(composePath)}
        className="px-4 py-2 text-sm bg-sky-600 hover:bg-sky-500 text-white font-semibold rounded-lg transition-colors"
      >
        Retry
      </button>
    );

    if (busy) return (
      <button disabled className="px-4 py-2 text-sm text-gray-500 cursor-not-allowed">
        Running…
      </button>
    );

    return (
      <button onClick={onClose} className="px-4 py-2 text-sm bg-gray-700 hover:bg-gray-600 text-white rounded-lg transition-colors">
        Close
      </button>
    );
  })();

  // ─── Body ─────────────────────────────────────────────────────────────────────

  return (
    <Dialog
      open
      title={`Migrate — ${stack.meta?.title ?? stack.name}`}
      onClose={busy ? () => {} : onClose}
      disableBackdropClose={busy}
      size="lg"
      footer={footer}
    >
      <div className="space-y-4">

        {phase === "idle" && (
          <p className="text-sm text-gray-400">
            This will copy the CasaOS compose file into anpan-os management and redeploy.{" "}
            <span className="text-gray-300">Existing data volumes are preserved</span> — Docker reuses
            them by matching the project name.
          </p>
        )}

        {phaseLabel[phase] && (
          <div className="flex items-center gap-2 text-sm text-gray-300">
            {busy && <Loader2 size={14} className="animate-spin text-sky-400 shrink-0" />}
            {phaseLabel[phase]}
          </div>
        )}

        {log.length > 0 && (
          <pre
            ref={logRef}
            className="h-56 bg-black rounded-lg border border-gray-700 p-3 text-xs text-green-400 font-mono overflow-y-auto whitespace-pre-wrap"
          >
            {log.join("\n")}
          </pre>
        )}

        {phase === "needPath" && (
          <div className="space-y-2">
            {errorMsg && (
              <p className="text-amber-400 text-sm bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2">
                {errorMsg}
              </p>
            )}
            <label className="block text-xs text-gray-400">Compose file path</label>
            <input
              type="text"
              value={composePath}
              onChange={e => setComposePath(e.target.value)}
              className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white font-mono focus:outline-none focus:border-sky-500"
              placeholder={defaultPath}
            />
          </div>
        )}

        {phase === "error" && (
          <p className="text-red-400 text-sm bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
            {errorMsg}
          </p>
        )}

      </div>
    </Dialog>
  );
}
