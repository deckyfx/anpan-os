import { useEffect, useRef, useState } from "react";
import { CheckSquare, Square, Loader2, CheckCircle2, XCircle } from "lucide-react";
import { Dialog } from "../../components/Dialog";
import { api } from "../../lib/api";
import { useUpdateCheckStore } from "../../stores/updateCheckStore";

// ─── Types ────────────────────────────────────────────────────────────────────

interface SSEMsg { log?: string; ok?: boolean; error?: string }

interface UpdateResult {
  stack: string;
  success: boolean;
  error?: string;
}

type Phase = "select" | "updating" | "done";

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * Dialog that shows all stacks with available image updates, lets the user
 * select which ones to update, then runs docker-compose pull+up sequentially
 * for each selected stack using the existing pull SSE endpoint.
 */
export function UpdatesDialog({ open, onClose, onUpdated }: {
  open: boolean;
  onClose: () => void;
  onUpdated: () => void;
}) {
  const { results, closeDialog } = useUpdateCheckStore();

  // Group images with updates by stack
  const stacksWithUpdates = [...new Set(
    results.filter(r => r.hasUpdate).map(r => r.stack)
  )].sort();

  const imagesForStack = (stackName: string) =>
    results.filter(r => r.stack === stackName && r.hasUpdate).map(r => r.image);

  // Phase and selection state
  const [phase, setPhase]         = useState<Phase>("select");
  const [selected, setSelected]   = useState<Set<string>>(() => new Set(stacksWithUpdates));
  const [updateQueue, setQueue]   = useState<string[]>([]);
  const [current, setCurrent]     = useState<string | null>(null);
  const [currentLog, setCurrentLog] = useState<string[]>([]);
  const [updateResults, setUpdateResults] = useState<UpdateResult[]>([]);

  const logRef = useRef<HTMLPreElement | null>(null);

  // Reset to select phase when opened
  useEffect(() => {
    if (open) {
      setPhase("select");
      setSelected(new Set(stacksWithUpdates));
      setQueue([]);
      setCurrent(null);
      setCurrentLog([]);
      setUpdateResults([]);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Auto-scroll log
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [currentLog]);

  // Run sequential updates when queue changes
  useEffect(() => {
    if (phase !== "updating" || updateQueue.length === 0 || current !== null) return;

    const [next, ...rest] = updateQueue;
    if (!next) {
      setPhase("done");
      return;
    }

    setCurrent(next);
    setCurrentLog([]);
    setQueue(rest);

    void (async () => {
      try {
        const { data, error: err } = await api.api.compose.stacks({ name: next }).pull.post();
        if (err || !data) {
          const msg = err ? ((err.value as { error?: string })?.error ?? "Request failed") : "No data";
          setUpdateResults(prev => [...prev, { stack: next, success: false, error: msg }]);
          setCurrent(null);
          return;
        }
        for await (const event of data as AsyncIterable<{ data: SSEMsg }>) {
          const m = event.data as SSEMsg;
          if (m.log !== undefined) {
            setCurrentLog(prev => [...prev, m.log!]);
          } else if (m.ok) {
            setUpdateResults(prev => [...prev, { stack: next, success: true }]);
            setCurrent(null);
            onUpdated();
            return;
          } else if (m.error) {
            setUpdateResults(prev => [...prev, { stack: next, success: false, error: m.error }]);
            setCurrent(null);
            return;
          }
        }
        // Stream ended without ok/error
        setUpdateResults(prev => [...prev, { stack: next, success: false, error: "Stream ended unexpectedly" }]);
        setCurrent(null);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setUpdateResults(prev => [...prev, { stack: next, success: false, error: msg }]);
        setCurrent(null);
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, updateQueue, current]);

  // When queue empties and no current task, transition to done
  useEffect(() => {
    if (phase === "updating" && current === null && updateQueue.length === 0 && updateResults.length > 0) {
      setPhase("done");
    }
  }, [phase, current, updateQueue, updateResults]);

  const toggleStack = (name: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const toggleAll = () => {
    if (selected.size === stacksWithUpdates.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(stacksWithUpdates));
    }
  };

  const startUpdates = () => {
    const queue = stacksWithUpdates.filter(s => selected.has(s));
    if (queue.length === 0) return;
    setPhase("updating");
    setUpdateResults([]);
    setCurrent(null);
    setQueue(queue);
  };

  const handleClose = () => {
    closeDialog();
    onClose();
  };

  // ─── Select phase content ────────────────────────────────────────────────

  const allSelected = selected.size === stacksWithUpdates.length;

  const selectContent = (
    <div className="space-y-3">
      <p className="text-sm text-gray-400">
        The following stacks have docker image updates available. Select which to update.
      </p>

      {stacksWithUpdates.length === 0 ? (
        <p className="text-sm text-gray-500 italic">No updates found.</p>
      ) : (
        <>
          {/* Select all toggle */}
          <button
            onClick={toggleAll}
            className="flex items-center gap-2 text-xs text-gray-400 hover:text-white transition-colors"
          >
            {allSelected
              ? <CheckSquare size={14} className="text-amber-400" />
              : <Square size={14} />
            }
            {allSelected ? "Deselect all" : "Select all"}
          </button>

          {/* Stack list */}
          <div className="space-y-2">
            {stacksWithUpdates.map(name => {
              const images = imagesForStack(name);
              const isSelected = selected.has(name);
              return (
                <button
                  key={name}
                  onClick={() => toggleStack(name)}
                  className={`w-full text-left flex items-start gap-3 px-3 py-2.5 rounded-xl border transition-colors ${
                    isSelected
                      ? "border-amber-500/40 bg-amber-500/5"
                      : "border-gray-700 hover:border-gray-600 bg-gray-800/40"
                  }`}
                >
                  <span className="mt-0.5 shrink-0">
                    {isSelected
                      ? <CheckSquare size={15} className="text-amber-400" />
                      : <Square size={15} className="text-gray-500" />
                    }
                  </span>
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-gray-100">{name}</p>
                    <p className="text-[10px] text-gray-500 truncate mt-0.5">
                      {images.length === 1 ? "1 image" : `${images.length} images`}:{" "}
                      {images.map(img => img.split("/").pop()?.split(":")[0] ?? img).join(", ")}
                    </p>
                  </div>
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );

  const selectFooter = (
    <>
      <button onClick={handleClose} className="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors">
        Cancel
      </button>
      <button
        onClick={startUpdates}
        disabled={selected.size === 0}
        className="px-4 py-2 text-sm bg-amber-500 hover:bg-amber-400 text-black font-semibold rounded-lg transition-colors disabled:opacity-40"
      >
        Update {selected.size > 0 ? `${selected.size} stack${selected.size !== 1 ? "s" : ""}` : ""}
      </button>
    </>
  );

  // ─── Updating phase content ──────────────────────────────────────────────

  const allQueued = stacksWithUpdates.filter(s => selected.has(s));
  const doneCount = updateResults.length;
  const totalCount = allQueued.length;

  const updatingContent = (
    <div className="space-y-3">
      {/* Progress summary */}
      <div className="flex items-center gap-2 text-sm text-gray-300">
        <Loader2 size={14} className="animate-spin text-sky-400 shrink-0" />
        Updating {current ?? "…"} ({doneCount + 1}/{totalCount})
      </div>

      {/* Completed stacks */}
      {updateResults.map(r => (
        <div key={r.stack} className="flex items-center gap-2 text-xs">
          {r.success
            ? <CheckCircle2 size={13} className="text-green-400 shrink-0" />
            : <XCircle size={13} className="text-red-400 shrink-0" />
          }
          <span className={r.success ? "text-gray-300" : "text-red-400"}>{r.stack}</span>
          {r.error && <span className="text-gray-500 truncate">— {r.error}</span>}
        </div>
      ))}

      {/* Log for current stack */}
      {currentLog.length > 0 && (
        <pre
          ref={logRef}
          className="h-48 bg-black rounded-lg border border-gray-700 p-3 text-xs text-green-400 font-mono overflow-y-auto whitespace-pre-wrap"
        >
          {currentLog.join("\n")}
        </pre>
      )}
    </div>
  );

  const updatingFooter = (
    <button disabled className="px-4 py-2 text-sm text-gray-500 cursor-not-allowed">
      Updating…
    </button>
  );

  // ─── Done phase content ──────────────────────────────────────────────────

  const successCount = updateResults.filter(r => r.success).length;
  const failCount    = updateResults.filter(r => !r.success).length;

  const doneContent = (
    <div className="space-y-3">
      <p className="text-sm text-gray-300">
        {successCount > 0 && (
          <span className="text-green-400">{successCount} stack{successCount !== 1 ? "s" : ""} updated successfully. </span>
        )}
        {failCount > 0 && (
          <span className="text-red-400">{failCount} stack{failCount !== 1 ? "s" : ""} failed.</span>
        )}
      </p>
      <div className="space-y-1.5">
        {updateResults.map(r => (
          <div key={r.stack} className="flex items-center gap-2 text-xs">
            {r.success
              ? <CheckCircle2 size={13} className="text-green-400 shrink-0" />
              : <XCircle size={13} className="text-red-400 shrink-0" />
            }
            <span className={r.success ? "text-gray-300" : "text-red-400"}>{r.stack}</span>
            {r.error && <span className="text-gray-500 truncate">— {r.error}</span>}
          </div>
        ))}
      </div>
    </div>
  );

  const doneFooter = (
    <button onClick={handleClose} className="px-4 py-2 text-sm bg-gray-700 hover:bg-gray-600 text-white rounded-lg transition-colors">
      Close
    </button>
  );

  // ─── Render ──────────────────────────────────────────────────────────────

  return (
    <Dialog
      open={open}
      title={
        phase === "select"   ? "Available Image Updates" :
        phase === "updating" ? "Updating Stacks…" :
                               "Update Complete"
      }
      onClose={phase === "updating" ? () => {} : handleClose}
      disableBackdropClose={phase === "updating"}
      size="md"
      footer={
        phase === "select"   ? selectFooter :
        phase === "updating" ? updatingFooter :
                               doneFooter
      }
    >
      {phase === "select"   ? selectContent   :
       phase === "updating" ? updatingContent :
                              doneContent}
    </Dialog>
  );
}
