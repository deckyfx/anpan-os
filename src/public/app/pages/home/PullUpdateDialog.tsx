import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Dialog } from "../../components/Dialog";
import { JobView } from "../../components/JobView";
import { api } from "../../lib/api";
import { useToastStore } from "../../stores/toastStore";
import { useJobsStore, runningJobFor, readStartAnswer } from "../../stores/jobsStore";
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

/**
 * Pull a stack's images and redeploy it, as a server-side job.
 *
 * Opened while a job is already working on the stack (say, an update started from another
 * tab), it shows that job instead of offering to start a second one.
 */
function PullUpdateDialogInner({ stack, onClose, onUpdated }: {
  stack: Stack;
  onClose: () => void;
  onUpdated: () => void;
}) {
  const title = stack.meta?.title ?? stack.name;
  const alreadyRunning = useJobsStore(s => runningJobFor(s.jobs, stack.name));
  const [jobId, setJobId] = useState<string | null>(alreadyRunning?.id ?? null);
  /** The job this dialog's own request started: only its success is reported as this update's. */
  const [ownJobId, setOwnJobId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");

  const start = async () => {
    setStarting(true);
    setError("");
    try {
      const { data, error: err } = await api.api.compose.stacks({ name: stack.name }).pull.post();
      const answer = readStartAnswer(data, err);
      // A 409 hands over the job already on the stack: shown, but not this request's.
      if (answer.job) setJobId(answer.job.id);
      if (answer.job && answer.started) setOwnJobId(answer.job.id);
      if (answer.error) setError(answer.error);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
    }
  };

  const footer = (
    <>
      <button onClick={onClose} className="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors">
        Close
      </button>
      {!jobId && (
        <button
          onClick={() => void start()}
          disabled={starting}
          className="inline-flex items-center gap-2 px-4 py-2 text-sm bg-sky-600 hover:bg-sky-500 text-white font-semibold rounded-lg transition-colors disabled:opacity-50"
        >
          {starting && <Loader2 size={14} className="animate-spin" />}
          Pull &amp; Update
        </button>
      )}
    </>
  );

  return (
    <Dialog
      open
      title={`Pull Update — ${title}`}
      onClose={onClose}
      size="lg"
      notification={error ? (
        <p className="text-red-400 text-sm bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">{error}</p>
      ) : undefined}
      footer={footer}
    >
      {jobId ? (
        <JobView
          jobId={jobId}
          onFinished={job => {
            // Another job may hold the stack: an install, a migration, or an update started
            // from another tab. Its success is not this request's; the stacks list refreshes
            // on its own when any job ends.
            if (job.status !== "done" || job.id !== ownJobId) return;
            useToastStore.getState().push(`Stack updated: ${title}`, "success");
            onUpdated();
          }}
        />
      ) : (
        <p className="text-sm text-gray-400">
          Pull the latest images for <span className="text-white font-medium">{title}</span> and re-deploy the stack.
        </p>
      )}
    </Dialog>
  );
}
