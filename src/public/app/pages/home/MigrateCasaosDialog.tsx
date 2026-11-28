import { useState } from "react";
import { Loader2, ArrowRightLeft } from "lucide-react";
import { Dialog } from "../../components/Dialog";
import { JobView } from "../../components/JobView";
import { api } from "../../lib/api";
import { useToastStore } from "../../stores/toastStore";
import { useJobsStore, runningJobFor, readStartAnswer } from "../../stores/jobsStore";
import type { Stack } from "./types";

/**
 * Outer guard — renders nothing when closed or no stack is selected.
 * Forces a full remount via `key` when the target stack changes so all
 * state is reset cleanly between migrations.
 */
export function MigrateCasaosDialog({ stack, open, onClose, onDone }: {
  stack: Stack | null;
  open: boolean;
  onClose: () => void;
  /** Called after a successful migration so the parent can refresh the stack list. */
  onDone: () => void;
}) {
  if (!open || !stack) return null;
  return <MigrateCasaosDialogInner key={stack.name} stack={stack} onClose={onClose} onDone={onDone} />;
}

/**
 * Inner migration dialog. Starts the migration as a server-side job and shows it.
 *
 * When the server cannot read the default compose path it answers `needPath: true`, which
 * puts the dialog into a form so the user can give the file's real location.
 * No sudo password is required — anpan-os is assumed to run as root.
 */
function MigrateCasaosDialogInner({ stack, onClose, onDone }: {
  stack: Stack;
  onClose: () => void;
  onDone: () => void;
}) {
  const defaultPath = `/var/lib/casaos/apps/${stack.name}/docker-compose.yml`;
  const title = stack.meta?.title ?? stack.name;

  // Reopened while this stack's migration still runs: show it. Any other kind of job on the
  // stack is not a migration, and the request below would be told about it.
  const alreadyRunning = useJobsStore(s => {
    const job = runningJobFor(s.jobs, stack.name);
    return job?.kind === "migrate" ? job : null;
  });
  const [jobId,       setJobId]       = useState<string | null>(alreadyRunning?.id ?? null);
  const [starting,    setStarting]    = useState(false);
  const [needPath,    setNeedPath]    = useState(false);
  const [errorMsg,    setErrorMsg]    = useState("");
  const [composePath, setComposePath] = useState(defaultPath);

  /** Start (or retry) the migration, optionally with a different compose file path. */
  const runMigration = async (path?: string) => {
    setErrorMsg("");
    setStarting(true);
    try {
      const { data, error: err } = await api.api.casaos.migrate({ name: stack.name }).post(
        path ? { composePath: path } : {},
      );
      const answer = readStartAnswer(data, err);
      if (answer.job && answer.started) {
        setJobId(answer.job.id);
        setNeedPath(false);
      }
      if (answer.error && !answer.started) {
        setErrorMsg(answer.error);
        setNeedPath(Boolean((err as { value?: { needPath?: boolean } } | null)?.value?.needPath));
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(false);
    }
  };

  // ─── Footer ──────────────────────────────────────────────────────────────────

  const footer = jobId ? (
    <button onClick={onClose} className="px-4 py-2 text-sm bg-gray-700 hover:bg-gray-600 text-white rounded-lg transition-colors">
      Close
    </button>
  ) : (
    <>
      <button onClick={onClose} className="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors">
        Cancel
      </button>
      <button
        onClick={() => void runMigration(needPath ? composePath : undefined)}
        disabled={starting}
        className="px-4 py-2 text-sm bg-sky-600 hover:bg-sky-500 text-white font-semibold rounded-lg transition-colors flex items-center gap-2 disabled:opacity-50"
      >
        {starting ? <Loader2 size={14} className="animate-spin" /> : <ArrowRightLeft size={14} />}
        {needPath ? "Retry" : "Start Migration"}
      </button>
    </>
  );

  // ─── Body ─────────────────────────────────────────────────────────────────────

  return (
    <Dialog open title={`Migrate — ${title}`} onClose={onClose} size="lg" footer={footer}>
      <div className="space-y-4">
        {jobId ? (
          <JobView
            jobId={jobId}
            logHeight="h-56"
            onFinished={job => {
              // Only a migration's success is one: an update that held the stack is not.
              if (job.status !== "done" || job.kind !== "migrate") return;
              useToastStore.getState().push(`Migrated ${title} to anpan-os`, "success");
              onDone();
            }}
          />
        ) : (
          <>
            {!needPath && (
              <p className="text-sm text-gray-400">
                This will copy the CasaOS compose file into anpan-os management and redeploy.{" "}
                <span className="text-gray-300">Existing data volumes are preserved</span> — Docker reuses
                them by matching the project name.
              </p>
            )}

            {needPath && (
              <div className="space-y-2">
                {errorMsg && (
                  <p className="text-amber-400 text-sm bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2">
                    {errorMsg}
                  </p>
                )}
                <label htmlFor="migrate-compose-path" className="block text-xs text-gray-400">Compose file path</label>
                <input
                  id="migrate-compose-path"
                  type="text"
                  value={composePath}
                  onChange={e => setComposePath(e.target.value)}
                  className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white font-mono focus:outline-none focus:border-sky-500"
                  placeholder={defaultPath}
                />
              </div>
            )}

            {!needPath && errorMsg && (
              <p role="alert" className="text-red-400 text-sm bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
                {errorMsg}
              </p>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}
