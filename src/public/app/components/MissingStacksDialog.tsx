import { useState, useEffect, useRef } from "react";
import { Loader2, RefreshCw, Eraser, FolderOpen } from "lucide-react";
import { Dialog } from "./Dialog";
import { api } from "../lib/api";
import { useToastStore } from "../stores/toastStore";
import { useUpdateCheckStore } from "../stores/updateCheckStore";

/** Mirrors MissingStack in src/lib/missing-stacks.ts. */
interface MissingStack {
  id: string;
  title: string | null;
  icon: string | null;
  managed: boolean;
  composeOnDisk: boolean;
}

/** Load the stacks anpan-os remembers but Docker no longer has. */
export async function fetchMissingStacks(): Promise<MissingStack[]> {
  const { data, error } = await api.api.docker.stacks.missing.get();
  if (error) throw new Error((error.value as { error?: string })?.error ?? `HTTP ${error.status}`);
  return (data as { stacks?: MissingStack[] } | null)?.stacks ?? [];
}

/**
 * One remembered stack, with its Forget button.
 *
 * Module scope rather than inside the dialog, so a row keeps its identity (and the
 * keyboard focus on its button) when the dialog's state changes.
 */
function Row({ stack, busy, anyBusy, onForget }: {
  stack: MissingStack;
  busy: boolean;
  anyBusy: boolean;
  onForget: () => void;
}) {
  return (
    <div className="flex items-start gap-3 py-2.5 border-b border-gray-800/40 last:border-0">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-gray-200 truncate">{stack.title || stack.id}</span>
          {stack.title && <code className="text-[10px] font-mono text-gray-600 truncate">{stack.id}</code>}
          <span className={`px-1.5 py-0.5 rounded border text-[10px] font-medium shrink-0 ${
            stack.managed
              ? "text-amber-300 bg-amber-500/10 border-amber-500/20"
              : "text-gray-500 bg-gray-500/10 border-gray-500/20"
          }`}>
            {stack.managed ? "Installed" : "Discovered"}
          </span>
        </div>
        <p className="mt-1 text-[11px] text-gray-600 leading-snug">
          {stack.composeOnDisk ? (
            <span className="inline-flex items-center gap-1 text-yellow-600">
              <FolderOpen size={11} /> Compose folder still on disk. It is kept, so the stack can be deployed again.
            </span>
          ) : stack.managed
            ? "No containers and no compose folder. It was removed outside anpan-os."
            : "Seen once in Docker, no longer there."}
        </p>
      </div>
      <button
        onClick={onForget}
        disabled={anyBusy}
        className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs text-gray-300 bg-gray-800 border border-gray-700 hover:bg-gray-700 transition-colors disabled:opacity-40 shrink-0"
      >
        {busy ? <Loader2 size={12} className="animate-spin" /> : <Eraser size={12} />}
        {busy ? "Forgetting…" : "Forget"}
      </button>
    </div>
  );
}

/**
 * Stacks that anpan-os still holds records for although Docker has no container for them,
 * typically because they were removed by hand with `docker compose down`.
 *
 * The home page lists what Docker reports, so these cannot be deleted from there. Forgetting
 * one removes only what anpan-os stored about it (title, icon, ports, update results) and
 * leaves every file in place.
 */
export function MissingStacksDialog({ open, onClose }: {
  open: boolean;
  onClose: () => void;
}) {
  const [stacks,  setStacks]  = useState<MissingStack[]>([]);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState("");
  const [busyId,  setBusyId]  = useState<string | null>(null);
  // A reload and a forget can overlap; only the newest load may write the list.
  const requestIdRef = useRef(0);

  const load = async () => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError("");
    try {
      const list = await fetchMissingStacks();
      if (requestId === requestIdRef.current) setStacks(list);
    } catch (e) {
      if (requestId !== requestIdRef.current) return;
      setError(e instanceof Error ? e.message : "Could not load the list");
      setStacks([]);
    }
    if (requestId === requestIdRef.current) setLoading(false);
  };

  useEffect(() => {
    if (open) void load();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const forget = async (stack: MissingStack) => {
    setBusyId(stack.id);
    try {
      const { error: err } = await api.api.docker.stacks({ name: stack.id }).forget.post();
      if (err) {
        useToastStore.getState().push((err.value as { error?: string })?.error ?? "Could not forget the stack", "error");
        return;
      }
      // A scan started before this forget may still list the stack; let none of them land.
      ++requestIdRef.current;
      setLoading(false);
      useUpdateCheckStore.getState().forgetStack(stack.id);
      useToastStore.getState().push(`Forgot ${stack.title || stack.id}`, "success");
      setStacks(prev => prev.filter(s => s.id !== stack.id));
    } catch (e) {
      useToastStore.getState().push(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Dialog
      open={open}
      title="Missing Stacks"
      onClose={onClose}
      size="lg"
      footer={
        <button
          onClick={() => void load()}
          disabled={loading}
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs text-gray-400 hover:text-white hover:bg-gray-800 transition-colors disabled:opacity-40"
        >
          <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
          Re-scan
        </button>
      }
    >
      <div className="space-y-4">
        <p className="text-xs text-gray-500 leading-relaxed">
          anpan-os still has records for these stacks, but Docker has no container for any of
          them, so they no longer appear on the home page.
          <span className="text-gray-600"> Forgetting one removes only those records. No files, images or volumes are touched.</span>
        </p>

        {error && (
          <div className="px-4 py-2.5 rounded-xl border text-xs font-medium text-red-400 bg-red-500/10 border-red-500/20">
            {error}
          </div>
        )}

        <div className="bg-gray-950 border border-gray-800 rounded-xl px-4">
          {loading && stacks.length === 0 ? (
            <div className="flex items-center gap-2 py-6 text-xs text-gray-600">
              <Loader2 size={13} className="animate-spin" /> Comparing with Docker…
            </div>
          ) : error ? (
            <p className="py-6 text-xs text-gray-500">Scan failed. Use Re-scan to try again.</p>
          ) : stacks.length === 0 ? (
            <p className="py-6 text-xs text-green-400">Every stack anpan-os knows about is in Docker.</p>
          ) : (
            stacks.map(s => (
              <Row
                key={s.id}
                stack={s}
                busy={busyId === s.id}
                anyBusy={busyId !== null}
                onForget={() => void forget(s)}
              />
            ))
          )}
        </div>
      </div>
    </Dialog>
  );
}
