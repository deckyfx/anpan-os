import { useId, useMemo, useState } from "react";
import { Archive, Loader2 } from "lucide-react";
import { Section } from "../account/Section";
import { PRIMARY_BUTTON, QUIET_BUTTON, TARGET } from "../account/styles";
import { api } from "../../lib/api";
import { useStacksStore } from "../../stores/stacksStore";
import { useToastStore } from "../../stores/toastStore";
import type { Stack } from "../home/types";

/** Stacks that have a compose file anpan-os can read, which is what a backup needs. */
function backupable(stacks: Stack[]): Stack[] {
  return stacks
    .filter(s => s.origin === "managed" || s.origin === "casaos")
    .sort((a, b) => (a.meta?.title ?? a.name).localeCompare(b.meta?.title ?? b.name));
}

/**
 * Choose what to back up — the system, and which apps — and start the backup.
 *
 * Each app also has its "copy while running" setting here, since this is where it matters:
 * off, the app is stopped while its data is copied; on, it keeps running and a database it
 * writes to during the copy may not restore.
 */
export function BackUpNowSection({ busy, onStart }: {
  /** A backup, restore or import is running; nothing new can start. */
  busy: boolean;
  onStart: (body: { system: boolean; apps: string[] }) => Promise<void>;
}) {
  const stacks = useStacksStore(s => s.stacks);
  const apps = useMemo(() => backupable(stacks), [stacks]);
  const [system, setSystem] = useState(true);
  // Unticked apps, rather than ticked ones, so an app installed while the page is open is
  // included by default, like the rest.
  const [skipped, setSkipped] = useState<ReadonlySet<string>>(new Set());
  const [starting, setStarting] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const listId = useId();

  const chosen = apps.filter(a => !skipped.has(a.name)).map(a => a.name);
  const nothing = !system && chosen.length === 0;

  const toggle = (name: string) => setSkipped(prev => {
    const next = new Set(prev);
    if (next.has(name)) next.delete(name); else next.add(name);
    return next;
  });

  const setLive = async (stack: Stack, live: boolean) => {
    setSaving(stack.name);
    try {
      const { error } = await api.api.docker.stacks({ name: stack.name }).patch({ backupLive: live });
      if (error) throw new Error((error.value as { error?: string } | null)?.error ?? "Could not save the setting");
      await useStacksStore.getState().loadStacks();
    } catch (e) {
      useToastStore.getState().push(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setSaving(null);
    }
  };

  const start = async () => {
    setStarting(true);
    try { await onStart({ system, apps: chosen }); } finally { setStarting(false); }
  };

  return (
    <Section
      title="Back up now"
      description="Apps are stopped while their files are copied and started again after, unless set to copy while running."
      actions={
        // Not while a "copy while running" change is being saved: the backup reads it.
        <button type="button" onClick={() => void start()} disabled={busy || starting || nothing || saving !== null} className={PRIMARY_BUTTON}>
          {starting ? <Loader2 size={12} className="animate-spin" /> : <Archive size={12} />}
          Back up now
        </button>
      }
    >
      {/* What to back up, as one group: a fieldset, named by its legend. */}
      <fieldset>
      <legend className="sr-only">What to back up</legend>
      <label className={`flex items-start gap-3 py-2 cursor-pointer ${TARGET}`}>
        <input type="checkbox" checked={system} onChange={e => setSystem(e.target.checked)} className="mt-0.5 accent-blue-500" />
        <span>
          <span className="block text-sm text-gray-200">System</span>
          <span className="block text-xs text-gray-500">Settings, your account and API keys, and every app's tile settings</span>
        </span>
      </label>

      <div className="flex items-center gap-2 mt-3 mb-1">
        <h3 id={listId} className="flex-1 text-[10px] font-semibold text-gray-500 uppercase tracking-widest">
          Apps ({chosen.length} of {apps.length})
        </h3>
        <button type="button" onClick={() => setSkipped(new Set())} className={QUIET_BUTTON}>All</button>
        <button type="button" onClick={() => setSkipped(new Set(apps.map(a => a.name)))} className={QUIET_BUTTON}>None</button>
      </div>

      {apps.length === 0 ? (
        <p className="text-xs text-gray-500 py-2">No apps with a compose file yet.</p>
      ) : (
        <ul aria-labelledby={listId} className="divide-y divide-gray-800 border-y border-gray-800">
          {apps.map(stack => {
            const live = stack.meta?.backupLive ?? false;
            const title = stack.meta?.title ?? stack.name;
            return (
              <li key={stack.name} className="flex items-center gap-3 py-2 flex-wrap">
                <label className={`flex items-center gap-3 flex-1 min-w-48 cursor-pointer ${TARGET}`}>
                  <input
                    type="checkbox"
                    checked={!skipped.has(stack.name)}
                    onChange={() => toggle(stack.name)}
                    className="accent-blue-500"
                  />
                  <span className="min-w-0">
                    <span className="block text-sm text-gray-200 truncate">{title}</span>
                    {title !== stack.name && <span className="block text-[11px] text-gray-500 font-mono truncate">{stack.name}</span>}
                  </span>
                </label>
                <span className="flex items-center gap-2 text-xs text-gray-400">
                  <span id={`live-${stack.name}`}>Copy while running</span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={live}
                    aria-labelledby={`live-${stack.name}`}
                    aria-describedby={`live-${stack.name}-hint`}
                    // One change at a time: Back up now waits for it, and two in flight
                    // would let the first to finish release that wait early.
                    disabled={saving !== null}
                    onClick={() => void setLive(stack, !live)}
                    className={`relative inline-flex w-9 h-5 shrink-0 rounded-full transition-colors disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 ${live ? "bg-amber-500" : "bg-gray-700"}`}
                  >
                    <span className={`inline-block w-3.5 h-3.5 rounded-full bg-white shadow transition-transform mt-[3px] ${live ? "translate-x-[18px]" : "translate-x-[3px]"}`} />
                  </button>
                  <span id={`live-${stack.name}-hint`} className="sr-only">
                    {live ? "Kept running while copied; a database written during the copy may not restore" : "Stopped while copied"}
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
      </fieldset>
    </Section>
  );
}
