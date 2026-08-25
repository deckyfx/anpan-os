import React, { useState } from "react";
import { Trash2, Plus, ArrowRightLeft, Pencil } from "lucide-react";
import { Dialog } from "../../components/Dialog";
import { useFileStore } from "../../stores/fileStore";
import { AddShareDialog } from "./AddShareDialog";
import { EditShareDialog } from "./EditShareDialog";
import type { SambaShare } from "./types";

// ─── Status badge ─────────────────────────────────────────────────────────────

function StatusBadge({ ok }: { ok: boolean | null }) {
  if (ok === null) return <span className="text-xs text-gray-500">Checking…</span>;
  return ok
    ? <span className="text-xs text-green-400 border border-green-500/30 rounded-full px-2 py-0.5">patched</span>
    : <span className="text-xs text-amber-400 border border-amber-500/30 rounded-full px-2 py-0.5">not patched</span>;
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface Props {
  open:    boolean;
  onClose: () => void;
}

function SambaManagerDialogInner({ onClose }: Omit<Props, "open">) {
  const {
    shares, sambaSetupPresent, sambaError, sambaBackend,
    loadShares, checkSambaSetup, doSambaSetup, doSambaUnpatch, doSambaRebuild,
    reloadSmbd, reloadingSmbd,
    setSambaError, setRemoveShareTarget, removeShare, takeOverShare,
  } = useFileStore();

  const [busy,          setBusy]          = useState(false);
  const [addShareOpen,  setAddShareOpen]  = useState(false);
  const [editTarget,    setEditTarget]    = useState<SambaShare | null>(null);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setSambaError("");
    try {
      await action();
      await Promise.all([loadShares(), checkSambaSetup()]);
    } finally {
      setBusy(false);
    }
  }

  async function handleRemoveShare(share: (typeof shares)[number]) {
    setBusy(true);
    setSambaError("");
    setRemoveShareTarget(share);
    try {
      await removeShare();
      await loadShares();
    } finally {
      setBusy(false);
    }
  }

  async function handleTakeOver(name: string) {
    setBusy(true);
    setSambaError("");
    try {
      await takeOverShare(name);
    } finally {
      setBusy(false);
    }
  }

  const anpanShares = shares.filter((s) => s.source === "anpan");
  const externalShares = shares.filter((s) => s.source === "external");

  return (
    <Dialog
      open
      title="Samba Manager"
      size="lg"
      minHeight="600px"
      disableBackdropClose
      onClose={onClose}
      notification={sambaError ? <p className="text-xs text-red-400">{sambaError}</p> : undefined}
      footer={
        <button
          onClick={onClose}
          className="px-4 py-2 rounded-lg text-sm text-gray-300 hover:text-white hover:bg-gray-800 transition-colors"
        >
          Close
        </button>
      }
    >
      <div className="space-y-5 py-1">

        {/* ── Backend status ─────────────────────────────────────────────────
            Which server publishes these shares, and whether it is ready to. Named
            explicitly because the answer changes what the rest of this dialog can do —
            and because "my shares do not appear" is almost always answered here. */}
        <section>
          <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">
            {sambaBackend?.providerName ?? "Share Backend"}
          </h3>
          {sambaBackend?.detail && (
            <div className="rounded-lg bg-gray-800/60 border border-gray-700 px-4 py-3 mb-3">
              <p className={`text-xs ${sambaBackend.ready ? "text-gray-400" : "text-amber-400"}`}>
                {sambaBackend.detail}
              </p>
            </div>
          )}
        </section>

        {/* ── smb.conf integration ─────────────────────────────────────────────
            Samba-only. Apple's server has no config file to patch, so offering a
            "Patch smb.conf" button there would be a control that cannot do anything. */}
        {sambaBackend?.capabilities?.requiresSetup !== false && (
        <section>
          <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">smb.conf Integration</h3>
          <div className="rounded-lg bg-gray-800/60 border border-gray-700 divide-y divide-gray-700">

            <div className="px-4 py-3 flex items-center gap-3">
              <span className="text-xs text-gray-500 w-24 shrink-0">Status</span>
              <StatusBadge ok={sambaSetupPresent} />
            </div>

            <div className="px-4 py-3 flex items-center gap-3">
              <span className="text-xs text-gray-500 w-24 shrink-0">Actions</span>
              <div className="flex gap-2 flex-wrap">
                <button
                  disabled={busy || sambaSetupPresent === true}
                  onClick={() => void run(doSambaSetup)}
                  className="text-xs px-3 py-1.5 rounded bg-blue-700 hover:bg-blue-600 text-white transition-colors disabled:opacity-40"
                >
                  Patch smb.conf
                </button>
                <button
                  disabled={busy || sambaSetupPresent === false || sambaSetupPresent === null}
                  onClick={() => void run(doSambaUnpatch)}
                  className="text-xs px-3 py-1.5 rounded bg-gray-700 hover:bg-gray-600 text-gray-200 transition-colors disabled:opacity-40"
                >
                  Remove patch
                </button>
              </div>
            </div>
          </div>
        </section>
        )}

        {/* ── Config file ────────────────────────────────────────────────── */}
        <section>
          <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">Config File</h3>
          <div className="rounded-lg bg-gray-800/60 border border-gray-700 divide-y divide-gray-700">
            <div className="px-4 py-3 flex items-center gap-3">
              <span className="text-xs text-gray-500 w-24 shrink-0">Actions</span>
              <div className="flex gap-2 flex-wrap">
                <button
                  disabled={busy}
                  onClick={() => void run(doSambaRebuild)}
                  className="text-xs px-3 py-1.5 rounded bg-amber-700 hover:bg-amber-600 text-white transition-colors disabled:opacity-40"
                >
                  Rebuild from DB
                </button>
                <button
                  disabled={busy || reloadingSmbd}
                  onClick={() => void run(reloadSmbd)}
                  className="text-xs px-3 py-1.5 rounded bg-gray-700 hover:bg-gray-600 text-gray-200 transition-colors disabled:opacity-40"
                >
                  {reloadingSmbd ? "Reloading…" : "Reload smbd"}
                </button>
              </div>
            </div>
            <div className="px-4 py-2.5">
              <p className="text-[11px] text-gray-600">
                "Rebuild from DB" regenerates the conf file from the SQLite database — use this if the file was
                accidentally deleted or corrupted.
              </p>
            </div>
          </div>
        </section>

        {/* ── Add share ──────────────────────────────────────────────────── */}
        <section className="flex items-center justify-between">
          <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Shares ({shares.length})</h3>
          <button
            disabled={busy}
            onClick={() => setAddShareOpen(true)}
            className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded bg-green-700 hover:bg-green-600 text-white transition-colors disabled:opacity-40"
          >
            <Plus size={12} /> Add Share
          </button>
        </section>

        <AddShareDialog
          open={addShareOpen}
          onClose={() => { setAddShareOpen(false); void loadShares(); }}
        />

        <EditShareDialog
          open={!!editTarget}
          share={editTarget!}
          onClose={() => { setEditTarget(null); void loadShares(); }}
        />

        {/* ── Shares ─────────────────────────────────────────────────────── */}
        <section>
          <div className="rounded-lg bg-gray-800/60 border border-gray-700 overflow-hidden">
            {shares.length === 0 && (
              <p className="px-4 py-3 text-xs text-gray-600">No shares configured.</p>
            )}

            <div className="max-h-96 overflow-y-auto">
              {anpanShares.length > 0 && (
                <>
                  <div className="px-4 py-1.5 bg-gray-800/80 border-b border-gray-700 sticky top-0">
                    <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide">Managed by anpan-os</span>
                  </div>
                  {anpanShares.map((share) => (
                    <div key={share.name} className="px-4 py-2.5 flex items-center gap-3 border-b border-gray-700/50 last:border-0">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="text-sm font-medium text-gray-200">{share.name}</span>
                          {share.readOnly && (
                            <span className="text-[9px] text-gray-500 border border-gray-600/30 rounded-full px-1.5">ro</span>
                          )}
                        </div>
                        <span className="text-xs text-gray-500 truncate block">{share.path}</span>
                        {share.comment && (
                          <span className="text-[11px] text-gray-600 italic">{share.comment}</span>
                        )}
                      </div>
                      <button
                        disabled={busy}
                        onClick={() => setEditTarget(share)}
                        title="Edit share"
                        className="p-1.5 rounded text-gray-600 hover:text-blue-400 hover:bg-blue-400/10 transition-colors disabled:opacity-40 shrink-0"
                      >
                        <Pencil size={13} />
                      </button>
                      <button
                        disabled={busy}
                        onClick={() => void handleRemoveShare(share)}
                        title="Remove share"
                        className="p-1.5 rounded text-gray-600 hover:text-red-400 hover:bg-red-400/10 transition-colors disabled:opacity-40 shrink-0"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  ))}
                </>
              )}

              {externalShares.length > 0 && (
                <>
                  <div className="px-4 py-1.5 bg-gray-800/80 border-t border-gray-700 sticky top-0">
                    <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide">External (CasaOS / other)</span>
                  </div>
                  {externalShares.map((share) => (
                    <div key={share.name} className="px-4 py-2.5 flex items-center gap-3 border-b border-gray-700/50 last:border-0">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="text-sm font-medium text-gray-200">{share.name}</span>
                          <span className="text-[9px] text-sky-500 border border-sky-500/30 rounded-full px-1.5">external</span>
                          {share.readOnly && (
                            <span className="text-[9px] text-gray-500 border border-gray-600/30 rounded-full px-1.5">ro</span>
                          )}
                        </div>
                        <span className="text-xs text-gray-500 truncate block">{share.path}</span>
                      </div>
                      <button
                        disabled={busy}
                        onClick={() => void handleTakeOver(share.name)}
                        title="Import this share into anpan-os management"
                        className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded bg-sky-700 hover:bg-sky-600 text-white transition-colors disabled:opacity-40 shrink-0"
                      >
                        <ArrowRightLeft size={11} />
                        Migrate to AnpanOS
                      </button>
                    </div>
                  ))}
                </>
              )}
            </div>
          </div>
        </section>

      </div>
    </Dialog>
  );
}

export function SambaManagerDialog({ open, onClose }: Props) {
  if (!open) return null;
  return <SambaManagerDialogInner onClose={onClose} />;
}
