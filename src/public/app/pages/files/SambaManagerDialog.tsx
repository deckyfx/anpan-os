import React, { useState } from "react";
import { Dialog } from "../../components/Dialog";
import { useFileStore } from "../../stores/fileStore";

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
    shares, sambaSetupPresent, sambaError,
    loadShares, checkSambaSetup, doSambaSetup, doSambaUnpatch, doSambaRebuild,
    reloadSmbd, reloadingSmbd,
    setSambaError,
  } = useFileStore();

  const [busy, setBusy] = useState(false);

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

  const anpanShares = shares.filter((s) => s.source === "anpan");
  const externalShares = shares.filter((s) => s.source === "external");

  return (
    <Dialog
      open
      title="Samba Manager"
      size="lg"
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

        {/* ── smb.conf integration ───────────────────────────────────────── */}
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

        {/* ── Shares ─────────────────────────────────────────────────────── */}
        <section>
          <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">
            All Shares ({shares.length})
          </h3>
          <div className="rounded-lg bg-gray-800/60 border border-gray-700 overflow-hidden">
            {shares.length === 0 && (
              <p className="px-4 py-3 text-xs text-gray-600">No shares configured.</p>
            )}

            {anpanShares.length > 0 && (
              <>
                <div className="px-4 py-1.5 bg-gray-800/80 border-b border-gray-700">
                  <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide">Managed by anpan-os</span>
                </div>
                {anpanShares.map((share) => (
                  <div key={share.name} className="px-4 py-2.5 flex items-start gap-3 border-b border-gray-700/50 last:border-0">
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
                  </div>
                ))}
              </>
            )}

            {externalShares.length > 0 && (
              <>
                <div className="px-4 py-1.5 bg-gray-800/80 border-t border-gray-700">
                  <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide">External (CasaOS / other)</span>
                </div>
                {externalShares.map((share) => (
                  <div key={share.name} className="px-4 py-2.5 flex items-start gap-3 border-b border-gray-700/50 last:border-0">
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
                  </div>
                ))}
              </>
            )}
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
