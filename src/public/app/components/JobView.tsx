import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Loader2, CheckCircle2, XCircle, Ban, Square } from "lucide-react";
import { useJobsStore, type JobSummary } from "../stores/jobsStore";

/**
 * One server-side job: its state, its current step, progress for a job over several
 * stacks, and its log as it grows.
 *
 * The job runs in the server, so closing whatever shows this does not stop it; the line
 * under the status says so while it runs. `onFinished` is called once when the job ends,
 * including when it had already ended before this mounted.
 */
export function JobView({ jobId, onFinished, logHeight = "h-64" }: {
  jobId: string;
  onFinished?: (job: JobSummary) => void;
  /** Tailwind height class for the log box. */
  logHeight?: string;
}) {
  const job = useJobsStore(s => s.jobs[jobId]);
  const log = useJobsStore(s => s.logs[jobId]);
  const watch = useJobsStore(s => s.watch);
  const [cancelling, setCancelling] = useState(false);

  useEffect(() => watch(jobId), [jobId, watch]);

  // Called once per job, from the first render that sees it finished.
  const finishedRef = useRef<string | null>(null);
  const onFinishedRef = useRef(onFinished);
  onFinishedRef.current = onFinished;
  useEffect(() => {
    if (job && job.status !== "running" && finishedRef.current !== job.id) {
      finishedRef.current = job.id;
      onFinishedRef.current?.(job);
    }
  }, [job]);

  // Follow the end of the log, unless the user has scrolled up to read.
  const logRef = useRef<HTMLPreElement>(null);
  const stickRef = useRef(true);
  useLayoutEffect(() => {
    const el = logRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [log?.lines.length]);

  if (!job) {
    return (
      <p className="flex items-center gap-2 text-sm text-gray-400">
        <Loader2 size={14} className="animate-spin" /> Loading job…
      </p>
    );
  }

  const running = job.status === "running";
  const pct = job.progress && job.progress.total > 0 ? Math.round((job.progress.done / job.progress.total) * 100) : null;

  const cancel = async () => {
    setCancelling(true);
    try { await useJobsStore.getState().cancel(job.id); } finally { setCancelling(false); }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-start gap-3 flex-wrap">
        <div className="flex-1 min-w-48" role="status" aria-live="polite">
          <p className="flex items-center gap-2 text-sm">
            {running && <Loader2 size={14} className="animate-spin text-sky-400 shrink-0" aria-hidden="true" />}
            {job.status === "done" && <CheckCircle2 size={14} className="text-green-400 shrink-0" aria-hidden="true" />}
            {job.status === "failed" && <XCircle size={14} className="text-red-400 shrink-0" aria-hidden="true" />}
            {job.status === "cancelled" && <Ban size={14} className="text-gray-400 shrink-0" aria-hidden="true" />}
            <span className={job.status === "failed" ? "text-red-300" : "text-gray-200"}>
              {running ? `${job.step}…` : job.status === "done" ? "Done" : job.status === "cancelled" ? "Cancelled" : "Failed"}
            </span>
          </p>
          {running && (
            <p className="text-[11px] text-gray-500 mt-0.5">This runs on the server: closing this window does not stop it.</p>
          )}
        </div>
        {running && (
          <button
            type="button"
            onClick={() => void cancel()}
            disabled={cancelling}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-gray-300 bg-gray-800 border border-gray-700 hover:bg-gray-700 hover:text-white transition-colors disabled:opacity-40 min-h-6 pointer-coarse:min-h-11"
          >
            {cancelling ? <Loader2 size={12} className="animate-spin" /> : <Square size={12} />}
            Cancel
          </button>
        )}
      </div>

      {job.error && (
        <p role="alert" className="text-red-400 text-sm bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2 break-words">
          {job.error}
        </p>
      )}

      {pct !== null && (
        <div>
          <div className="h-1.5 rounded-full bg-gray-800 overflow-hidden">
            <div className="h-full bg-sky-500 transition-[width]" style={{ width: `${pct}%` }} />
          </div>
          <p className="text-[11px] text-gray-500 mt-1">{job.progress!.done} of {job.progress!.total}</p>
        </div>
      )}

      <pre
        ref={logRef}
        onScroll={e => {
          const el = e.currentTarget;
          stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
        tabIndex={0}
        aria-label={`Log of ${job.title}`}
        className={`${logHeight} bg-black rounded-lg border border-gray-700 p-3 text-xs text-green-400 font-mono overflow-y-auto whitespace-pre-wrap break-words`}
      >
        {log && log.firstSeq > 0 ? `… ${log.firstSeq} earlier lines are in the stack's install log\n` : ""}
        {log?.lines.join("\n") ?? ""}
      </pre>
    </div>
  );
}
