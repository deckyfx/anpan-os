import { useEffect, useState } from "react";
import { CheckSquare, Square, Loader2 } from "lucide-react";
import { Dialog } from "../../components/Dialog";
import { JobView } from "../../components/JobView";
import { api } from "../../lib/api";
import { useUpdateCheckStore } from "../../stores/updateCheckStore";
import { useJobsStore, readStartAnswer } from "../../stores/jobsStore";

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * Dialog that shows all stacks with available image updates, lets the user select which
 * to update, then updates them as one server-side job.
 *
 * The job pulls and redeploys each stack in turn and carries on with this dialog, or the
 * whole tab, closed. Opened while such a job runs, the dialog shows it.
 */
export function UpdatesDialog({ open, onClose, onUpdated }: {
  open: boolean;
  onClose: () => void;
  onUpdated: () => void;
}) {
  const { results, closeDialog } = useUpdateCheckStore();
  const runningBulk = useJobsStore(s => Object.values(s.jobs).find(j => j.kind === "update-all" && j.status === "running") ?? null);

  // Group images with updates by stack
  const stacksWithUpdates = [...new Set(
    results.filter(r => r.hasUpdate).map(r => r.stack)
  )].sort();

  const imagesForStack = (stackName: string) =>
    results.filter(r => r.stack === stackName && r.hasUpdate).map(r => r.image);

  const [selected, setSelected] = useState<Set<string>>(() => new Set(stacksWithUpdates));
  const [jobId, setJobId]       = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError]       = useState("");

  // Reset when opened: show a bulk update already running, else the selection.
  useEffect(() => {
    if (open) {
      setSelected(new Set(stacksWithUpdates));
      setJobId(runningBulk?.id ?? null);
      setError("");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

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

  const startUpdates = async () => {
    const stacks = stacksWithUpdates.filter(name => selected.has(name));
    if (stacks.length === 0) return;
    setStarting(true);
    setError("");
    try {
      const { data, error: err } = await api.api.compose["update-all"].post({ stacks });
      const answer = readStartAnswer(data, err);
      if (answer.job) setJobId(answer.job.id);
      else setError(answer.error ?? "Could not start the update");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
    }
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
        onClick={() => void startUpdates()}
        disabled={selected.size === 0 || starting}
        className="inline-flex items-center gap-2 px-4 py-2 text-sm bg-amber-500 hover:bg-amber-400 text-black font-semibold rounded-lg transition-colors disabled:opacity-40"
      >
        {starting && <Loader2 size={14} className="animate-spin" />}
        Update {selected.size > 0 ? `${selected.size} stack${selected.size !== 1 ? "s" : ""}` : ""}
      </button>
    </>
  );

  const jobFooter = (
    <button onClick={handleClose} className="px-4 py-2 text-sm bg-gray-700 hover:bg-gray-600 text-white rounded-lg transition-colors">
      Close
    </button>
  );

  // ─── Render ──────────────────────────────────────────────────────────────

  return (
    <Dialog
      open={open}
      title={jobId ? "Updating Stacks" : "Available Image Updates"}
      onClose={handleClose}
      size="md"
      notification={error ? (
        <p className="text-red-400 text-sm bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">{error}</p>
      ) : undefined}
      footer={jobId ? jobFooter : selectFooter}
    >
      {jobId
        ? <JobView jobId={jobId} logHeight="h-72" onFinished={() => onUpdated()} />
        : selectContent}
    </Dialog>
  );
}
