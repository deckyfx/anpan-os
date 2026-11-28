import { useCallback, useEffect, useState } from "react";
import { Loader2, RotateCw, X } from "lucide-react";
import { TopBar } from "./home/TopBar";
import { Section } from "./account/Section";
import { PRIMARY_BUTTON, QUIET_BUTTON } from "./account/styles";
import { BackUpNowSection } from "./backups/BackUpNowSection";
import { BackupListSection } from "./backups/BackupListSection";
import type { BackupsListing } from "./backups/types";
import { JobView } from "../components/JobView";
import { api } from "../lib/api";
import { useRouter } from "../router";
import { useJobsStore, readStartAnswer, type JobKind } from "../stores/jobsStore";
import { useStacksStore } from "../stores/stacksStore";
import { useToastStore } from "../stores/toastStore";

/** Jobs that read or write the backups folder; the server runs one at a time. */
const BACKUP_KINDS: ReadonlySet<JobKind> = new Set(["backup", "restore", "backup-import"]);

/** Wait for the server to answer again after a restart, then reload the page. */
async function reloadWhenBack(): Promise<void> {
  // Give the old process time to stop first, so the first answer is the new one's.
  await new Promise(r => setTimeout(r, 3000));
  for (let i = 0; i < 60; i++) {
    // A deadline on each probe: a request caught by the restart may otherwise never settle.
    const ok = await fetch("/api/health", { signal: AbortSignal.timeout(3000) }).then(r => r.ok, () => false);
    if (ok) { location.reload(); return; }
    await new Promise(r => setTimeout(r, 2000));
  }
}

/**
 * The Backups page: take a backup, and restore, download, upload or delete backups.
 *
 * Backups, restores and imports run as server jobs, so leaving the page does not stop them;
 * the job shown here is the one running, whoever started it.
 */
export function BackupsPage({ onNavigate }: { onNavigate: (path: string) => void }) {
  const { path } = useRouter();
  const version = useStacksStore(s => s.version);
  const [listing, setListing] = useState<BackupsListing | null>(null);
  const [loadError, setLoadError] = useState("");
  const [shownJob, setShownJob] = useState<string | null>(null);
  const [restarting, setRestarting] = useState(false);

  // The top bar's version and the app list come from the stacks store.
  useEffect(() => { useStacksStore.getState().initialize(); }, []);

  const load = useCallback(async () => {
    try {
      const { data, error } = await api.api.backups.get();
      if (error) throw new Error((error.value as { error?: string } | null)?.error ?? "Could not list the backups");
      setListing(data as BackupsListing);
      setLoadError("");
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  // The backup job running now, from any tab, else the last one shown until dismissed. A new
  // job replaces a finished one, so its end is what the list refreshes on.
  const runningId = useJobsStore(s => Object.values(s.jobs).find(j => j.status === "running" && BACKUP_KINDS.has(j.kind))?.id ?? null);
  useEffect(() => { if (runningId) setShownJob(runningId); }, [runningId]);
  const jobId = runningId ?? shownJob;
  const job = useJobsStore(s => (jobId ? s.jobs[jobId] : undefined));
  // A job ending changes the list: a backup added, an import unpacked, a restore staged.
  const status = job?.status;
  useEffect(() => { if (status && status !== "running") void load(); }, [status, load]);

  const busy = runningId !== null;

  /** Start a job and show it; a refusal is a toast. */
  const startJob = async (request: Promise<{ data: unknown; error: unknown }>) => {
    const { data, error } = await request;
    const answer = readStartAnswer(data, error);
    if (answer.job) setShownJob(answer.job.id);
    if (answer.error) useToastStore.getState().push(answer.error, "error");
  };

  const applyRestore = async () => {
    setRestarting(true);
    const { data, error } = await api.api.backups["apply-restore"].post();
    if (error) {
      setRestarting(false);
      useToastStore.getState().push((error.value as { error?: string } | null)?.error ?? "Could not restart", "error");
      return;
    }
    if (!(data as { requested?: boolean }).requested) {
      setRestarting(false);
      useToastStore.getState().push("Restart anpan-os yourself to apply the restore: it is not running as the installed service", "error");
      return;
    }
    await reloadWhenBack();
    setRestarting(false);
  };

  return (
    <div className="flex flex-col h-screen bg-gray-950 text-white overflow-hidden">
      <TopBar version={version} onNavigate={onNavigate} currentPath={path} showUpdates={false} />
      <main className="flex-1 min-h-0 overflow-y-auto px-4 py-6 sm:px-6">
        <div className="max-w-3xl mx-auto space-y-5">
          <div>
            <h1 className="text-lg font-semibold text-white">Backups</h1>
            <p className="text-xs text-gray-500 mt-1 leading-relaxed max-w-prose">
              A backup holds anpan-os's settings and database, and each app's stack folder and its data under{" "}
              <code className="font-mono text-gray-400">{listing?.dataRoot ?? "the data root"}</code>. Folders an app mounts
              from elsewhere, such as a media library, and named Docker volumes are not included.
            </p>
          </div>

          {loadError && (
            <p role="alert" className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">{loadError}</p>
          )}

          {listing?.restorePending && (
            <div role="status" className="flex items-center gap-3 flex-wrap rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3">
              <p className="flex-1 min-w-60 text-sm text-amber-200">
                A system restore is staged. Restart anpan-os to apply it; you will need to sign in again with the backup's password.
              </p>
              <button type="button" onClick={() => void applyRestore()} disabled={restarting || busy} className={PRIMARY_BUTTON}>
                {restarting ? <Loader2 size={12} className="animate-spin" /> : <RotateCw size={12} />}
                {restarting ? "Restarting…" : "Restart now"}
              </button>
            </div>
          )}

          {jobId && (
            <Section
              title={job?.title ?? "Working…"}
              actions={job && job.status !== "running" && (
                <button type="button" onClick={() => setShownJob(null)} aria-label="Dismiss" className={`${QUIET_BUTTON} px-1.5`}>
                  <X size={12} />
                </button>
              )}
            >
              <JobView jobId={jobId} logHeight="h-56" />
            </Section>
          )}

          <BackUpNowSection
            busy={busy}
            onStart={body => startJob(api.api.backups.post(body))}
          />

          <BackupListSection
            folder={listing?.folder ?? "…"}
            backups={listing?.backups ?? null}
            busy={busy}
            onRestore={(id, body) => startJob(api.api.backups({ id }).restore.post(body))}
            onImport={upload => startJob(api.api.backups.import.post({ upload }))}
            onChanged={() => void load()}
          />
        </div>
      </main>
    </div>
  );
}
