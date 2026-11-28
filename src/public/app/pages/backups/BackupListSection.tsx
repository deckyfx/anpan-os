import { useId, useRef, useState } from "react";
import { Download, History, Trash2, Upload, X } from "lucide-react";
import { Section } from "../account/Section";
import { InlineConfirm } from "../account/InlineConfirm";
import { QUIET_BUTTON, TARGET } from "../account/styles";
import { api } from "../../lib/api";
import { UploadControl, uploadInChunks } from "../../lib/chunked-upload";
import { useToastStore } from "../../stores/toastStore";
import { describeContents, formatBytes, type BackupSummary } from "./types";

/**
 * The backups in the folder, each with Restore, Download and Delete, and Upload to add one
 * downloaded earlier (from this machine or another).
 */
export function BackupListSection({ folder, backups, busy, onRestore, onImport, onUploading, onChanged }: {
  folder: string;
  backups: BackupSummary[] | null;
  busy: boolean;
  onRestore: (id: string, body: { system: boolean; apps: string[] }) => Promise<void>;
  /** An upload finished: unpack it into a backup. */
  onImport: (uploadId: string) => Promise<void>;
  /** An upload started or ended; the page holds other work back meanwhile. */
  onUploading: (uploading: boolean) => void;
  onChanged: () => void;
}) {
  const [restoring, setRestoring] = useState<string | null>(null);
  const [deleting, setDeleting]   = useState<{ id: string; busy: boolean } | null>(null);

  const remove = async (id: string) => {
    setDeleting({ id, busy: true });
    try {
      const { error } = await api.api.backups({ id }).delete();
      if (error) throw new Error((error.value as { error?: string } | null)?.error ?? "Could not delete the backup");
      useToastStore.getState().push("Backup deleted", "success");
      onChanged();
    } catch (e) {
      useToastStore.getState().push(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setDeleting(null);
    }
  };

  return (
    <Section
      title="Backups"
      description={<>Kept in <code className="font-mono text-gray-400">{folder}</code>. Set <code className="font-mono text-gray-400">[backups] folder</code> in config.toml to keep them elsewhere, such as a mounted drive.</>}
      actions={<UploadButton disabled={busy} onUploaded={onImport} onUploading={onUploading} />}
    >
      {backups === null ? (
        <p className="text-xs text-gray-500">Loading…</p>
      ) : backups.length === 0 ? (
        <p className="text-xs text-gray-500">No backups yet.</p>
      ) : (
        <ul className="divide-y divide-gray-800 border-y border-gray-800">
          {backups.map(b => {
            const when = new Date(b.createdAt);
            const label = when.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
            return (
              <li key={b.id} className="py-3">
                <div className="flex items-center gap-3 flex-wrap">
                  <div className="flex-1 min-w-48">
                    <p className="text-sm text-gray-200"><time dateTime={b.createdAt}>{label}</time></p>
                    <p className="text-[11px] text-gray-500">
                      {describeContents(b)} · {formatBytes(b.size)} · {b.hostname} · v{b.version}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setRestoring(restoring === b.id ? null : b.id)}
                    disabled={busy}
                    aria-expanded={restoring === b.id}
                    className={QUIET_BUTTON}
                  >
                    <History size={12} /> Restore…
                  </button>
                  <a href={`/api/backups/${b.id}/download`} download className={QUIET_BUTTON} aria-label={`Download the backup from ${label}`}>
                    <Download size={12} /> Download
                  </a>
                  <InlineConfirm
                    label="Delete"
                    icon={<Trash2 size={12} />}
                    confirmLabel="Delete"
                    busyLabel="Deleting…"
                    subject={`the backup from ${label}`}
                    confirming={deleting?.id === b.id}
                    busy={deleting?.id === b.id && deleting.busy}
                    disabled={busy}
                    onAsk={() => setDeleting({ id: b.id, busy: false })}
                    onCancel={() => setDeleting(null)}
                    onConfirm={() => void remove(b.id)}
                  />
                </div>
                {restoring === b.id && (
                  <RestorePanel
                    backup={b}
                    busy={busy}
                    onClose={() => setRestoring(null)}
                    onRestore={async body => { await onRestore(b.id, body); setRestoring(null); }}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

/** What to restore from one backup, and the confirm. */
function RestorePanel({ backup, busy, onClose, onRestore }: {
  backup: BackupSummary;
  busy: boolean;
  onClose: () => void;
  onRestore: (body: { system: boolean; apps: string[] }) => Promise<void>;
}) {
  // Nothing ticked to start with: a restore replaces what is here, so each part is chosen.
  const [system, setSystem] = useState(false);
  const [apps, setApps] = useState<ReadonlySet<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  const headingId = useId();

  const toggle = (name: string) => setApps(prev => {
    const next = new Set(prev);
    if (next.has(name)) next.delete(name); else next.add(name);
    return next;
  });
  const nothing = !system && apps.size === 0;

  const send = async () => {
    setSending(true);
    try { await onRestore({ system, apps: [...apps] }); } finally { setSending(false); setConfirming(false); }
  };

  return (
    <div role="group" aria-labelledby={headingId} className="mt-3 rounded-lg border border-gray-700 bg-gray-950/60 p-4 space-y-3">
      <div className="flex items-center gap-2">
        <h3 id={headingId} className="flex-1 text-xs font-semibold text-gray-300">Restore from this backup</h3>
        <button type="button" onClick={onClose} aria-label="Close" className={`${QUIET_BUTTON} px-1.5`}><X size={12} /></button>
      </div>

      {backup.system && (
        <label className={`flex items-start gap-3 cursor-pointer ${TARGET}`}>
          <input type="checkbox" checked={system} onChange={e => { setSystem(e.target.checked); setConfirming(false); }} className="mt-0.5 accent-blue-500" />
          <span>
            <span className="block text-sm text-gray-200">System</span>
            <span className="block text-xs text-gray-500">
              Settings, your account, password, API keys and tile settings go back to the backup's when anpan-os next restarts.
            </span>
          </span>
        </label>
      )}
      {backup.apps.map(app => (
        <label key={app.name} className={`flex items-start gap-3 cursor-pointer ${TARGET}`}>
          <input type="checkbox" checked={apps.has(app.name)} onChange={() => { toggle(app.name); setConfirming(false); }} className="mt-0.5 accent-blue-500" />
          <span>
            <span className="block text-sm text-gray-200 font-mono">{app.name}</span>
            <span className="block text-xs text-gray-500">
              {app.dataDirs.length > 0 ? `Stack folder and data (${app.dataDirs.join(", ")})` : "Stack folder"}
              {app.live ? " · copied while running" : ""}
            </span>
          </span>
        </label>
      ))}

      <p className="text-xs text-gray-400 leading-relaxed">
        Each app chosen is stopped, and its stack folder and data are replaced by the backup's; anything added since is
        removed. What is there now is kept until the restore succeeds and put back if it fails.
      </p>
      <div className="flex justify-end">
        <InlineConfirm
          label="Restore"
          icon={<History size={12} />}
          confirmLabel="Replace with backup"
          busyLabel="Starting…"
          subject="the chosen parts"
          confirming={confirming}
          busy={sending}
          disabled={busy || nothing}
          onAsk={() => setConfirming(true)}
          onCancel={() => setConfirming(false)}
          onConfirm={() => void send()}
        />
      </div>
    </div>
  );
}

/** Pick a backup archive and upload it in chunks, with progress and Cancel. */
function UploadButton({ disabled, onUploaded, onUploading }: {
  disabled: boolean;
  onUploaded: (uploadId: string) => Promise<void>;
  onUploading: (uploading: boolean) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const control = useRef(new UploadControl());
  const [progress, setProgress] = useState<{ name: string; loaded: number; total: number } | null>(null);

  const upload = async (file: File) => {
    const id = crypto.randomUUID();
    control.current.reset();
    setProgress({ name: file.name, loaded: 0, total: file.size });
    onUploading(true);
    try {
      const failure = await uploadInChunks(`/api/backups/upload?id=${id}`, file, loaded => setProgress(p => p && { ...p, loaded }), control.current);
      if (failure) {
        if (failure !== "Cancelled") useToastStore.getState().push(`Upload failed: ${failure}`, "error");
        return;
      }
      await onUploaded(id);
    } finally {
      setProgress(null);
      onUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  if (progress) {
    const percent = progress.total > 0 ? Math.round((progress.loaded / progress.total) * 100) : 100;
    return (
      <div className="flex items-center gap-2 text-xs text-gray-400">
        <label className="flex items-center gap-2">
          <span className="truncate max-w-40" title={progress.name}>Uploading {percent}%</span>
          <progress value={progress.loaded} max={progress.total || 1} className="w-28 h-1.5 accent-blue-500" />
        </label>
        <button type="button" onClick={() => control.current.cancel()} className={QUIET_BUTTON}>Cancel</button>
      </div>
    );
  }
  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept=".tar,application/x-tar"
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={e => { const file = e.target.files?.[0]; if (file) void upload(file); }}
      />
      <button type="button" disabled={disabled} onClick={() => inputRef.current?.click()} className={QUIET_BUTTON}>
        <Upload size={12} /> Upload…
      </button>
    </>
  );
}
