import { useState, useEffect, useRef } from "react";
import { Trash2, HardDrive, AlertTriangle, Loader2, RefreshCw } from "lucide-react";
import { Dialog } from "./Dialog";
import { api } from "../lib/api";
import { useToastStore } from "../stores/toastStore";

/**
 * Reclaim Docker disk space, one category at a time.
 *
 * Deliberately not a single "clean up" button. The categories differ in what they cost to
 * get back: dangling images and build cache are byproducts nothing can miss, while
 * "unused" volumes are only unused in the sense that no container currently references
 * them — which on a host with stopped stacks describes their databases.
 *
 * Every prune therefore names its category twice, once to select it and once to confirm,
 * and the risky ones are visually separated from the safe ones.
 */

interface CategoryUsage {
  category: string;
  label: string;
  reclaimable: number;
  count: number;
  risky: boolean;
  note: string;
  approximate?: boolean;
}

interface DiskUsage {
  categories: CategoryUsage[];
  totalReclaimable: number;
}

function formatBytes(n: number): string {
  if (n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/**
 * One category row.
 *
 * Defined at module scope, not inside the dialog: a component declared during render is a
 * new type on every render, so React unmounts and remounts each row whenever any state
 * changes. A keyboard user pressing "Reclaim" would lose focus the instant the confirm
 * buttons appeared, because the button that received the press no longer exists.
 */
function Row({ c, confirming, busy, anyBusy, onConfirm, onCancel, onRun }: {
  c: CategoryUsage;
  confirming: boolean;
  /** This row's prune is running. */
  busy: boolean;
  /** Some prune is running, possibly another row's. */
  anyBusy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  onRun: () => void;
}) {
  const nothing = c.count === 0 && c.reclaimable === 0;

  return (
    <div className="flex items-start gap-3 py-2.5 border-b border-gray-800/40 last:border-0">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className={`text-xs font-medium ${c.risky ? "text-amber-300" : "text-gray-200"}`}>
            {c.label}
          </span>
          <span className="text-[10px] text-gray-600">
            {c.count} item{c.count === 1 ? "" : "s"}
          </span>
          {c.reclaimable > 0 && (
            <span
              className="text-[10px] text-gray-400 tabular-nums"
              title={c.approximate ? "Upper bound — image layers shared between images are counted once per image" : undefined}
            >
              {c.approximate ? "~" : ""}{formatBytes(c.reclaimable)}
            </span>
          )}
        </div>
        <p className="text-[11px] text-gray-600 mt-0.5 leading-relaxed">{c.note}</p>
      </div>

      {confirming ? (
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            onClick={onRun}
            className="text-[11px] px-2.5 py-1 rounded-lg bg-red-500/90 text-white hover:bg-red-500 transition-colors"
          >
            Delete {c.label.toLowerCase()}
          </button>
          <button
            onClick={onCancel}
            className="text-[11px] px-2 py-1 text-gray-400 hover:text-white transition-colors"
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          onClick={onConfirm}
          // Disabled while *any* prune runs, not just this row's: two concurrent prunes
          // share one busy flag, so the first to finish would clear it for the second and
          // leave the UI claiming the second had ended.
          disabled={anyBusy || nothing}
          title={nothing ? "Nothing to reclaim" : anyBusy ? "Another cleanup is running" : undefined}
          className="shrink-0 flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-lg text-gray-400 hover:text-white hover:bg-gray-800 transition-colors disabled:opacity-30 disabled:hover:bg-transparent"
        >
          {busy ? <Loader2 size={11} className="animate-spin" /> : <Trash2 size={11} />}
          Reclaim
        </button>
      )}
    </div>
  );
}

export function DiskCleanupDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [usage, setUsage]     = useState<DiskUsage | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy]       = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  // Rescan and reopen can overlap; without this an older response can overwrite a newer.
  const requestRef = useRef(0);

  const load = async () => {
    const requestId = ++requestRef.current;
    setLoading(true);
    try {
      const { data } = await (api.api.docker as unknown as {
        "disk-usage": { get: () => Promise<{ data: unknown }> };
      })["disk-usage"].get();
      if (requestId !== requestRef.current) return;   // superseded by a newer load
      const payload = data as DiskUsage | { error: string } | null;
      setUsage(payload && !("error" in payload) ? payload : null);
    } catch {
      if (requestId === requestRef.current) setUsage(null);
    } finally {
      if (requestId === requestRef.current) setLoading(false);
    }
  };

  useEffect(() => {
    if (open) { setConfirming(null); void load(); }
  }, [open]);

  const runPrune = async (category: CategoryUsage["category"]) => {
    // Guard the entry point too: the disabled button is a hint, not an enforcement.
    if (busy) return;
    setBusy(category);
    setConfirming(null);
    try {
      const { data, error } = await (api.api.docker as unknown as {
        prune: { post: (b: unknown) => Promise<{ data: unknown; error: unknown }> };
      }).prune.post({ category, confirm: category });

      if (error) {
        useToastStore.getState().push(
          (error as { value?: { error?: string } }).value?.error ?? "Could not reclaim space",
          "error",
        );
        return;
      }
      const result = data as { reclaimed: number; deleted: number } | null;
      useToastStore.getState().push(
        result
          ? `Reclaimed ${formatBytes(result.reclaimed)} from ${result.deleted} item${result.deleted === 1 ? "" : "s"}`
          : "Nothing to reclaim",
        "success",
      );
      await load();
    } catch (err) {
      useToastStore.getState().push(
        err instanceof Error ? err.message : "Could not reclaim space",
        "error",
      );
    } finally {
      setBusy(null);
    }
  };

  const safe   = usage?.categories.filter(c => !c.risky) ?? [];
  const risky  = usage?.categories.filter(c => c.risky)  ?? [];

  return (
    <Dialog open={open} title="Docker disk cleanup" onClose={onClose} size="lg"
      footer={
        <div className="flex items-center gap-2 w-full">
          <button
            onClick={() => void load()}
            disabled={loading}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-gray-800 text-gray-200 hover:bg-gray-700 transition-colors disabled:opacity-50"
          >
            <RefreshCw size={12} className={loading ? "animate-spin" : ""} /> Rescan
          </button>
          {usage && (
            <span className="text-[11px] text-gray-500">
              {formatBytes(usage.totalReclaimable)} reclaimable without risk
            </span>
          )}
        </div>
      }
    >
      <div className="space-y-4">
        {loading && !usage && (
          <div className="flex items-center gap-2 py-8 text-xs text-gray-600">
            <Loader2 size={13} className="animate-spin" /> Reading Docker disk usage…
          </div>
        )}

        {!loading && !usage && (
          <p className="py-8 text-center text-xs text-gray-600">
            Could not read Docker disk usage.
          </p>
        )}

        {usage && (
          <>
            <div>
              <p className="text-[10px] text-gray-600 font-semibold uppercase tracking-widest mb-1.5 flex items-center gap-2">
                <HardDrive size={11} /> Safe to reclaim
              </p>
              <div className="bg-gray-950 border border-gray-800 rounded-xl px-3">
                {safe.map(c => (
                  <Row key={c.category} c={c}
                    confirming={confirming === c.category}
                    busy={busy === c.category}
                    anyBusy={busy !== null}
                    onConfirm={() => setConfirming(c.category)}
                    onCancel={() => setConfirming(null)}
                    onRun={() => void runPrune(c.category)} />
                ))}
              </div>
            </div>

            <div>
              <p className="text-[10px] text-amber-600/80 font-semibold uppercase tracking-widest mb-1.5 flex items-center gap-2">
                <AlertTriangle size={11} /> Needs thought
              </p>
              {/* Separated rather than merged into one list: these are reclaimable in the
                  same technical sense, and destructive in a way the others are not. */}
              <div className="bg-gray-950 border border-amber-900/30 rounded-xl px-3">
                {risky.map(c => (
                  <Row key={c.category} c={c}
                    confirming={confirming === c.category}
                    busy={busy === c.category}
                    anyBusy={busy !== null}
                    onConfirm={() => setConfirming(c.category)}
                    onCancel={() => setConfirming(null)}
                    onRun={() => void runPrune(c.category)} />
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}
