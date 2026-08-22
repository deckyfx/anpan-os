import { useState } from "react";
import { ArrowUpCircle, CheckCircle2, AlertCircle, MinusCircle, Trash2, RefreshCw } from "lucide-react";
import { Dialog } from "../../components/Dialog";
import { useUpdateCheckStore } from "../../stores/updateCheckStore";
import type { ImageUpdateResult } from "../../stores/updateCheckStore";

/** "3 weeks", "2 days", "4 hours" — coarse on purpose; exactness adds nothing here. */
function since(iso: string | null): string | null {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  const mins = Math.floor(ms / 60_000);
  if (mins < 60)      return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24)     return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 14)      return `${days}d`;
  return `${Math.floor(days / 7)}w`;
}

function Row({ r, tone }: { r: ImageUpdateResult; tone: "update" | "ok" | "error" | "skip" }) {
  const icon = {
    update: <ArrowUpCircle size={13} className="text-amber-400" />,
    ok:     <CheckCircle2  size={13} className="text-green-500" />,
    error:  <AlertCircle   size={13} className="text-red-400" />,
    skip:   <MinusCircle   size={13} className="text-gray-600" />,
  }[tone];

  const age = tone === "update" ? since(r.firstSeenAt) : null;

  return (
    <div className="flex items-center gap-2.5 py-1.5 border-b border-gray-800/40 last:border-0">
      <span className="shrink-0">{icon}</span>
      <span className="text-xs text-gray-300 w-32 shrink-0 truncate" title={r.stack}>{r.stack}</span>
      <span className="text-[11px] text-gray-500 flex-1 truncate font-mono" title={r.image}>{r.image}</span>
      {age && (
        <span className="text-[10px] text-amber-500/80 shrink-0" title="How long this update has been available">
          {age}
        </span>
      )}
      {(r.error || r.skippedReason) && (
        <span className="text-[10px] text-gray-600 shrink-0 max-w-48 truncate" title={r.error ?? r.skippedReason ?? ""}>
          {r.error ?? r.skippedReason}
        </span>
      )}
    </div>
  );
}

function Section({ label, count, children, defaultOpen = true }: {
  label: string; count: number; children: React.ReactNode; defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  if (count === 0) return null;
  return (
    <div>
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center gap-2 text-[10px] text-gray-600 font-semibold uppercase tracking-widest mb-1.5 hover:text-gray-400 transition-colors"
      >
        <span>{label}</span>
        <span className="text-gray-700">({count})</span>
        <span className="ml-auto text-gray-700">{open ? "−" : "+"}</span>
      </button>
      {open && <div className="bg-gray-950 border border-gray-800 rounded-xl px-3 mb-3">{children}</div>}
    </div>
  );
}

/**
 * Results of the last update sweep.
 *
 * Separate from the mass-update dialog because reading and acting are different jobs:
 * previously results were only visible by triggering more work, and anything that was not
 * a plain "update available" — a skipped digest-pinned image, a registry that refused —
 * had nowhere to appear at all.
 */
export function UpdateReportDialog({ open, onClose, onUpdateStacks }: {
  open: boolean;
  onClose: () => void;
  onUpdateStacks: () => void;
}) {
  const { results, run, running, purge, purging, startCheck } = useUpdateCheckStore();
  const [confirmPurge, setConfirmPurge] = useState(false);

  const updates = results.filter(r => r.hasUpdate);
  const errors  = results.filter(r => r.error);
  const skipped = results.filter(r => r.skippedReason && !r.error);
  const upToDate = results.filter(r => !r.hasUpdate && !r.error && !r.skippedReason);

  const checked = run?.finishedAt ?? run?.startedAt ?? null;
  const ago = since(checked);

  return (
    <Dialog open={open} title="Image update report" onClose={onClose} size="lg"
      footer={
        <div className="flex items-center gap-2 w-full">
          <button
            onClick={() => { setConfirmPurge(false); void startCheck({ auto: false, force: running }); }}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-gray-800 text-gray-200 hover:bg-gray-700 transition-colors"
          >
            <RefreshCw size={12} /> Check all
          </button>

          {updates.length > 0 && (
            <button
              onClick={onUpdateStacks}
              className="text-xs px-3 py-1.5 rounded-lg bg-amber-500 text-black font-medium hover:bg-amber-400 transition-colors"
            >
              Update {updates.length} image{updates.length !== 1 ? "s" : ""}…
            </button>
          )}

          <div className="ml-auto flex items-center gap-2">
            {confirmPurge ? (
              <>
                <span className="text-[11px] text-gray-500">Badges return after the next check.</span>
                <button
                  onClick={async () => { setConfirmPurge(false); await purge(); }}
                  disabled={purging}
                  className="text-xs px-3 py-1.5 rounded-lg bg-red-500/90 text-white hover:bg-red-500 transition-colors disabled:opacity-50"
                >
                  {purging ? "Clearing…" : "Clear anyway"}
                </button>
                <button onClick={() => setConfirmPurge(false)} className="text-xs px-2 py-1.5 text-gray-400 hover:text-white">
                  Keep
                </button>
              </>
            ) : (
              <button
                onClick={() => setConfirmPurge(true)}
                disabled={running || results.length === 0}
                title={running ? "Cancel the running check first" : "Delete stored results and check history"}
                className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg text-gray-500 hover:text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-gray-500"
              >
                <Trash2 size={12} /> Clear results
              </button>
            )}
          </div>
        </div>
      }
    >
      <div className="space-y-3">
        {/* Run summary */}
        <div className="flex items-center gap-3 text-[11px] text-gray-500 px-1">
          {running ? (
            <span className="flex items-center gap-1.5 text-sky-400">
              <span className="w-3 h-3 border-2 border-sky-400 border-t-transparent rounded-full animate-spin" />
              Checking {run?.completed ?? 0}/{run?.total ?? 0}…
            </span>
          ) : run ? (
            <>
              <span>Last checked {ago ? `${ago} ago` : "—"}</span>
              <span className="text-gray-700">·</span>
              <span>{run.completed}/{run.total} images</span>
              {run.status !== "done" && <><span className="text-gray-700">·</span><span className="text-amber-500">{run.status}</span></>}
              {run.getFallbacks > 0 && (
                <>
                  <span className="text-gray-700">·</span>
                  <span title="Registries that refused HEAD; these consume pull rate budget">
                    {run.getFallbacks} GET fallback{run.getFallbacks !== 1 ? "s" : ""}
                  </span>
                </>
              )}
            </>
          ) : (
            <span>No check has run yet.</span>
          )}
        </div>

        {results.length === 0 && !running && (
          <p className="py-8 text-center text-xs text-gray-600">
            Nothing recorded. Run a check to populate this report.
          </p>
        )}

        <Section label="Updates available" count={updates.length}>
          {updates.map(r => <Row key={`${r.stack}/${r.image}`} r={r} tone="update" />)}
        </Section>

        <Section label="Could not check" count={errors.length}>
          {errors.map(r => <Row key={`${r.stack}/${r.image}`} r={r} tone="error" />)}
        </Section>

        <Section label="Skipped" count={skipped.length} defaultOpen={false}>
          {skipped.map(r => <Row key={`${r.stack}/${r.image}`} r={r} tone="skip" />)}
        </Section>

        <Section label="Up to date" count={upToDate.length} defaultOpen={false}>
          {upToDate.map(r => <Row key={`${r.stack}/${r.image}`} r={r} tone="ok" />)}
        </Section>
      </div>
    </Dialog>
  );
}
