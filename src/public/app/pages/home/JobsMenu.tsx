import { useRef, useState } from "react";
import { Loader2, ListChecks, CheckCircle2, XCircle, Ban } from "lucide-react";
import { AnchoredMenu } from "../../components/AnchoredMenu";
import { Dialog } from "../../components/Dialog";
import { JobView } from "../../components/JobView";
import { useJobsStore, type JobSummary } from "../../stores/jobsStore";
import { TARGET } from "../account/styles";

/** Jobs shown in the menu: every running one, then the most recent finished ones. */
const RECENT = 8;

function StatusIcon({ job }: { job: JobSummary }) {
  if (job.status === "running")   return <Loader2 size={13} className="animate-spin text-sky-400 shrink-0" aria-hidden="true" />;
  if (job.status === "done")      return <CheckCircle2 size={13} className="text-green-400 shrink-0" aria-hidden="true" />;
  if (job.status === "cancelled") return <Ban size={13} className="text-gray-500 shrink-0" aria-hidden="true" />;
  return <XCircle size={13} className="text-red-400 shrink-0" aria-hidden="true" />;
}

/** "2 min ago", for when a finished job ended. */
function ago(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return `${Math.round(s / 3600)} h ago`;
}

/**
 * The Jobs control in the top bar: installs, deploys, updates and migrations running on the
 * server, and the ones that just finished.
 *
 * Those jobs continue after their dialog is closed, so this is the way back to one. Hidden
 * until there is a job to show; while any runs, it shows a spinner and the count.
 */
export function JobsMenu() {
  const jobs = useJobsStore(s => s.jobs);
  const [open, setOpen] = useState(false);
  const [viewing, setViewing] = useState<string | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  const all = Object.values(jobs).sort((a, b) => b.startedAt - a.startedAt);
  const running = all.filter(j => j.status === "running");
  const shown = [...running, ...all.filter(j => j.status !== "running").slice(0, Math.max(0, RECENT - running.length))];
  if (shown.length === 0 && !viewing) return null;

  const viewingJob = viewing ? jobs[viewing] : undefined;

  return (
    <>
      {shown.length > 0 && (
        <button
          ref={btnRef}
          type="button"
          onClick={() => setOpen(v => !v)}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={running.length > 0 ? `Jobs: ${running.length} running` : "Recent jobs"}
          className={`ml-1 flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg transition-colors shrink-0 ${TARGET} ${
            open ? "bg-gray-800 text-white" : running.length > 0 ? "text-sky-300 hover:bg-gray-800" : "text-gray-400 hover:text-white hover:bg-gray-800"
          }`}
        >
          {running.length > 0 ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <ListChecks size={14} aria-hidden="true" />}
          <span className="hidden sm:inline">Jobs</span>
          {running.length > 0 && <span className="text-[11px] font-semibold">{running.length}</span>}
        </button>
      )}

      {open && (
        <AnchoredMenu anchor={btnRef} onClose={() => setOpen(false)} label="Jobs" className="w-80">
          {shown.map(job => (
            <button
              key={job.id}
              type="button"
              onClick={() => { setOpen(false); setViewing(job.id); }}
              className="w-full flex items-start gap-2.5 px-3 py-2 rounded-lg hover:bg-gray-700 focus-visible:bg-gray-700 text-left transition-colors"
            >
              <span className="mt-0.5"><StatusIcon job={job} /></span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm text-gray-200 truncate">{job.title}</span>
                <span className="block text-[11px] text-gray-500 truncate">
                  {job.status === "running"
                    ? `${job.step}…${job.progress ? ` (${job.progress.done}/${job.progress.total})` : ""}`
                    : `${job.status === "done" ? "Done" : job.status === "cancelled" ? "Cancelled" : job.error ?? "Failed"} · ${ago(job.finishedAt ?? job.startedAt)}`}
                </span>
              </span>
            </button>
          ))}
        </AnchoredMenu>
      )}

      {viewing && (
        <Dialog
          open
          title={viewingJob?.title ?? "Job"}
          onClose={() => setViewing(null)}
          size="lg"
          footer={
            <button onClick={() => setViewing(null)} className="px-4 py-2 text-sm bg-gray-700 hover:bg-gray-600 text-white rounded-lg transition-colors">
              Close
            </button>
          }
        >
          <JobView jobId={viewing} logHeight="h-80" />
        </Dialog>
      )}
    </>
  );
}
