import { useEffect, useRef, useState } from "react";
import { RefreshCw, FileText, XCircle, ChevronDown } from "lucide-react";
import { useUpdateCheckStore } from "../../stores/updateCheckStore";

/**
 * The Updates control in the top bar.
 *
 * A dropdown rather than a single button because the two actions are genuinely different:
 * starting a sweep changes state on the server, while viewing the report only reads it.
 * Conflating them meant the only way to see results was to trigger more work.
 */
export function UpdatesMenu() {
  const {
    running, run, blocked,
    startCheck, cancelCheck, openDialog, dismissBlocked,
    updatesCount, progressLabel,
  } = useUpdateCheckStore();

  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  const count    = updatesCount();
  const progress = progressLabel();

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const onCheckAll = async () => {
    setOpen(false);
    // startCheck reports its own failures; awaiting keeps the click from resolving before
    // the outcome is known, so a refusal cannot be mistaken for a started sweep.
    await startCheck({ auto: false });
  };

  const onViewReport = () => {
    setOpen(false);
    openDialog();
  };

  return (
    <div className="ml-3 relative shrink-0" ref={wrapRef}>
      <button
        onClick={() => setOpen(v => !v)}
        title={running ? `Checking images… ${progress ?? ""}` : "Docker image updates"}
        className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg transition-colors text-gray-400 hover:text-white hover:bg-gray-800"
      >
        {running
          ? <span className="w-3.5 h-3.5 border-2 border-sky-400 border-t-transparent rounded-full animate-spin shrink-0" />
          : <RefreshCw size={14} />
        }
        Updates
        {/* While a sweep runs the progress replaces the chevron — it is the more useful
            thing to show, and the menu is still reachable by clicking anywhere on it. */}
        {running && progress
          ? <span className="text-[10px] text-sky-400 tabular-nums">{progress}</span>
          : <ChevronDown size={12} className="text-gray-600" />
        }
      </button>

      {count > 0 && !running && (
        <button
          onClick={openDialog}
          title={`${count} stack${count !== 1 ? "s" : ""} have image updates available`}
          className="absolute -top-1 -right-1 min-w-4 h-4 px-1 rounded-full bg-amber-500 text-black text-[9px] font-bold flex items-center justify-center hover:bg-amber-400 transition-colors leading-none"
        >
          {count}
        </button>
      )}

      {open && (
        <div className="absolute left-0 top-full mt-1.5 w-52 bg-gray-900 border border-gray-700 rounded-xl shadow-2xl py-1 z-50">
          <MenuItem
            icon={<RefreshCw size={13} />}
            label={running ? "Check running…" : "Check all"}
            hint={running ? progress ?? undefined : undefined}
            onClick={onCheckAll}
          />
          <MenuItem
            icon={<FileText size={13} />}
            label="View report"
            hint={count > 0 ? `${count} with updates` : undefined}
            onClick={onViewReport}
          />
          {running && (
            <>
              <div className="h-px bg-gray-800 my-1" />
              <MenuItem
                icon={<XCircle size={13} />}
                label="Cancel check"
                danger
                onClick={() => { setOpen(false); void cancelCheck(); }}
              />
            </>
          )}
        </div>
      )}

      {/* A manual check that collided with a running one — ask rather than silently
          doing nothing, since the user explicitly asked for a fresh check. */}
      {blocked && (
        <div className="absolute left-0 top-full mt-1.5 w-72 bg-gray-900 border border-gray-700 rounded-xl shadow-2xl p-3 z-50">
          <p className="text-xs text-gray-300 leading-relaxed">
            {blocked.reason === "running"
              ? <>A check is already running — {blocked.run.completed}/{blocked.run.total} done.</>
              : <>A check finished recently.</>}
          </p>
          <p className="text-[11px] text-gray-500 mt-1">
            {blocked.reason === "running"
              ? "Cancel it and start a fresh one?"
              : "Run another anyway?"}
          </p>
          <div className="flex gap-2 mt-3">
            <button
              onClick={async () => { dismissBlocked(); await startCheck({ auto: false, force: true }); }}
              className="flex-1 text-xs px-2 py-1.5 rounded-lg bg-amber-500 text-black font-medium hover:bg-amber-400 transition-colors"
            >
              {blocked.reason === "running" ? "Restart check" : "Check again"}
            </button>
            <button
              onClick={dismissBlocked}
              className="flex-1 text-xs px-2 py-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-gray-800 transition-colors"
            >
              Keep waiting
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function MenuItem({ icon, label, hint, onClick, danger }: {
  icon: React.ReactNode;
  label: string;
  hint?: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-2.5 px-3 py-2 text-xs transition-colors text-left
        ${danger ? "text-red-400 hover:bg-red-500/10" : "text-gray-300 hover:bg-gray-800 hover:text-white"}`}
    >
      <span className="shrink-0">{icon}</span>
      <span className="flex-1">{label}</span>
      {hint && <span className="text-[10px] text-gray-500 tabular-nums">{hint}</span>}
    </button>
  );
}
