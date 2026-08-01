import { useState, useEffect, useRef } from "react";
import {
  CheckCircle, XCircle, AlertCircle, Loader2, RefreshCw, Wrench, HelpCircle,
} from "lucide-react";
import { Dialog } from "./Dialog";
import { api } from "../lib/api";
import { useToastStore } from "../stores/toastStore";

// ─── Types ────────────────────────────────────────────────────────────────────

type Status = "ok" | "drift" | "mixed" | "external" | "unknown";

interface ComposeSourceReport {
  stack: string;
  status: Status;
  needsRepair: boolean;
  expected: string;
  expectedExists: boolean;
  containers: Array<{
    container: string;
    configFiles: string[];
    workingDir: string;
    matches: boolean;
    dangling: boolean;
  }>;
  foreignPaths: string[];
}

interface SSEMsg { log?: string; ok?: boolean; error?: string }

// ─── Status presentation ──────────────────────────────────────────────────────

const STATUS_META: Record<Status, { label: string; cls: string; icon: React.ReactNode }> = {
  ok:       { label: "OK",       cls: "text-green-400  bg-green-500/10  border-green-500/20",  icon: <CheckCircle size={13} className="text-green-400" /> },
  drift:    { label: "Drift",    cls: "text-red-400    bg-red-500/10    border-red-500/20",    icon: <XCircle     size={13} className="text-red-400" /> },
  mixed:    { label: "Mixed",    cls: "text-red-400    bg-red-500/10    border-red-500/20",    icon: <XCircle     size={13} className="text-red-400" /> },
  external: { label: "External", cls: "text-yellow-400 bg-yellow-500/10 border-yellow-500/20", icon: <AlertCircle size={13} className="text-yellow-400" /> },
  unknown:  { label: "Unknown",  cls: "text-gray-500   bg-gray-500/10   border-gray-500/20",   icon: <HelpCircle  size={13} className="text-gray-500" /> },
};

const STATUS_HINT: Record<Status, string> = {
  ok:       "Every container was created from the managed compose file.",
  drift:    "The managed compose file exists, but some containers still carry an older path. They were skipped by a past deploy and never recreated.",
  mixed:    "This project is split across two or more compose files, with no managed copy.",
  external: "Managed outside anpan-os — all containers agree on one compose file. Not a fault.",
  unknown:  "No compose labels found — a standalone container, or Docker was unreachable.",
};

// ─── Per-stack row ────────────────────────────────────────────────────────────

function StackRow({ report, onRepaired }: {
  report: ComposeSourceReport;
  onRepaired: () => void;
}) {
  const [busy, setBusy]   = useState(false);
  const [log,  setLog]    = useState<string[]>([]);
  const [err,  setErr]    = useState("");
  const logRef            = useRef<HTMLPreElement | null>(null);
  const meta              = STATUS_META[report.status];

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  const repair = async () => {
    setBusy(true);
    setLog([]);
    setErr("");

    try {
      const { data, error } = await api.api.compose.stacks({ name: report.stack }).repair.post();
      if (error) {
        setErr((error.value as { error?: string })?.error ?? "Request failed");
        setBusy(false);
        return;
      }

      for await (const event of data as AsyncIterable<{ data: SSEMsg }>) {
        const m = event.data as SSEMsg;
        if (m.log !== undefined) {
          setLog(prev => [...prev, m.log!]);
        } else if (m.ok) {
          useToastStore.getState().push(`Repaired ${report.stack}`, "success");
          setBusy(false);
          onRepaired();
          return;
        } else if (m.error) {
          setErr(m.error);
          setBusy(false);
          return;
        }
      }
      setBusy(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div className="py-3 border-b border-gray-800/50 last:border-0">
      <div className="flex items-center gap-2.5">
        <span className="shrink-0">{meta.icon}</span>
        <span className="text-sm font-medium text-gray-200 truncate">{report.stack}</span>
        <span className={`px-1.5 py-0.5 rounded border text-[10px] font-medium shrink-0 ${meta.cls}`}>
          {meta.label}
        </span>
        <span className="flex-1" />
        {report.needsRepair && (
          <button
            onClick={repair}
            disabled={busy}
            title="Recreate this stack's containers so they all point at the managed compose file"
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs text-amber-300 bg-amber-500/10 border border-amber-500/20 hover:bg-amber-500/20 transition-colors disabled:opacity-40 shrink-0"
          >
            {busy ? <Loader2 size={12} className="animate-spin" /> : <Wrench size={12} />}
            {busy ? "Repairing…" : "Repair"}
          </button>
        )}
      </div>

      <p className="ml-6 mt-1 text-[11px] text-gray-600 leading-snug">{STATUS_HINT[report.status]}</p>

      {report.status !== "ok" && (
        <div className="ml-6 mt-2 space-y-1">
          <p className="text-[10px] text-gray-600">
            expected <code className="font-mono text-gray-500">{report.expected}</code>
            {!report.expectedExists && <span className="text-yellow-600"> (missing)</span>}
          </p>
          {report.containers.map(c => (
            <div key={c.container} className="flex items-start gap-2 text-[11px]">
              <span className="shrink-0 mt-0.5">
                {c.matches
                  ? <CheckCircle size={11} className="text-green-500" />
                  : <XCircle     size={11} className="text-red-500" />}
              </span>
              <span className="font-mono text-gray-400 w-44 shrink-0 truncate">{c.container}</span>
              <span className="font-mono text-gray-600 break-all">
                {c.configFiles.join(", ") || "no compose labels"}
                {c.dangling && <span className="text-red-500"> (file no longer exists)</span>}
              </span>
            </div>
          ))}
        </div>
      )}

      {log.length > 0 && (
        <pre
          ref={logRef}
          className="ml-6 mt-2 max-h-32 overflow-y-auto bg-black/40 border border-gray-800 rounded-lg p-2 text-[10px] font-mono text-gray-500 whitespace-pre-wrap"
        >
          {log.join("")}
        </pre>
      )}

      {err && (
        <p className="ml-6 mt-2 text-[11px] text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-2 py-1.5">
          {err}
        </p>
      )}
    </div>
  );
}

// ─── Main dialog ──────────────────────────────────────────────────────────────

/**
 * Shows which compose file each stack's containers were actually created from, and
 * offers to re-anchor drifted stacks onto the managed compose folder.
 *
 * Repair recreates containers, so it is deliberately a per-stack action behind an
 * explicit click rather than something the read-only Doctor panel performs.
 */
export function ComposeSourcesDialog({ open, onClose }: {
  open: boolean;
  onClose: () => void;
}) {
  const [reports, setReports] = useState<ComposeSourceReport[]>([]);
  const [loading, setLoading] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [error,   setError]   = useState("");

  // `load` runs from the open/showAll effect, the Re-scan button and onRepaired, so two
  // calls can be in flight at once and resolve out of order. Every state write is gated on
  // still being the newest request, otherwise a slow earlier scan overwrites a fresh one.
  const requestIdRef = useRef(0);

  const load = async (all: boolean) => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError("");
    try {
      const { data, error: err } = await api.api.compose["compose-sources"].get(
        all ? { query: { all: "1" } } : { query: {} },
      );
      if (requestId !== requestIdRef.current) return;
      if (err) throw new Error(String(err.status));
      const payload = data as { stacks?: ComposeSourceReport[]; error?: string } | null;
      if (payload?.error) setError(payload.error);
      setReports(payload?.stacks ?? []);
    } catch (e) {
      if (requestId !== requestIdRef.current) return;
      setError(e instanceof Error ? e.message : "Could not load compose sources");
      setReports([]);
    }
    if (requestId === requestIdRef.current) setLoading(false);
  };

  useEffect(() => {
    if (open) void load(showAll);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, showAll]);

  const broken = reports.filter(r => r.needsRepair);

  return (
    <Dialog
      open={open}
      title="Compose Sources"
      onClose={onClose}
      size="xl"
      footer={
        <div className="flex items-center gap-3 w-full">
          <label className="flex items-center gap-1.5 text-xs text-gray-500 cursor-pointer">
            <input
              type="checkbox"
              checked={showAll}
              onChange={e => setShowAll(e.target.checked)}
              className="accent-amber-500"
            />
            Show healthy stacks
          </label>
          <span className="flex-1" />
          <button
            onClick={() => void load(showAll)}
            disabled={loading}
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs text-gray-400 hover:text-white hover:bg-gray-800 transition-colors disabled:opacity-40"
          >
            <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
            Re-scan
          </button>
        </div>
      }
    >
      <div className="space-y-4">
        <p className="text-xs text-gray-500 leading-relaxed">
          Docker records which compose file created each container. A redeploy only recreates
          containers whose definition changed, so moving a stack can leave some containers
          anchored to the old file — sometimes one that no longer exists.
          <span className="text-gray-600"> Repairing recreates the stack's containers; named volumes are kept, but each stack restarts briefly.</span>
        </p>

        {error && (
          <div className="px-4 py-2.5 rounded-xl border text-xs font-medium text-red-400 bg-red-500/10 border-red-500/20">
            {error}
          </div>
        )}

        <div className="bg-gray-950 border border-gray-800 rounded-xl px-4">
          {loading && reports.length === 0 ? (
            <div className="flex items-center gap-2 py-6 text-xs text-gray-600">
              <Loader2 size={13} className="animate-spin" /> Scanning compose projects…
            </div>
          ) : reports.length === 0 ? (
            <p className="py-6 text-xs text-green-400">
              All stacks point at the managed compose folder.
            </p>
          ) : (
            reports.map(r => (
              <StackRow key={r.stack} report={r} onRepaired={() => void load(showAll)} />
            ))
          )}
        </div>

        {broken.length > 0 && (
          <div className="px-4 py-2.5 rounded-xl border text-xs font-medium text-red-400 bg-red-500/10 border-red-500/20">
            {broken.length} stack{broken.length !== 1 ? "s" : ""} need repair.
          </div>
        )}
      </div>
    </Dialog>
  );
}
