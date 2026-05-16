import { useFileStore } from "../../stores/fileStore";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { PrivilegeGuard } from "../../components/PrivilegeGuard";

// ─── Samba Section ────────────────────────────────────────────────────────────

export function SambaSection() {
  const {
    currentPath,
    shares, sambaOpen, removeShareTarget, addShareOpen, newShare, reloadingSmbd,
    sambaSetupPresent, sambaError,
    setSambaOpen, setRemoveShareTarget, setAddShareOpen, setNewShare, setSambaError,
    addShare, removeShare, reloadSmbd, doSambaSetup,
  } = useFileStore();

  const currentIsShared = shares.some((s) => s.path === currentPath);

  return (
    <PrivilegeGuard
      fallback={
        <div className="border-t border-gray-800 px-5 py-3">
          <div className="flex items-center gap-2 text-xs text-gray-600">
            <span className="opacity-50">Samba Shares</span>
            <span className="ml-auto text-[10px] text-amber-600 border border-amber-600/30 rounded-full px-2 py-0.5">Requires root</span>
          </div>
        </div>
      }
    >
      <div className="border-t border-gray-800 px-5 py-3">
        {/* Header row */}
        <div className="flex items-center gap-2 text-sm text-gray-400">
          <button
            onClick={() => setSambaOpen(!sambaOpen)}
            className="flex items-center gap-2 flex-1 hover:text-white transition-colors text-left"
          >
            <span className={`transition-transform ${sambaOpen ? "rotate-90" : ""}`}>›</span>
            <span>Samba Shares</span>
            {currentIsShared && (
              <span className="text-[10px] text-green-400 border border-green-500/30 rounded-full px-1.5 py-0">shared</span>
            )}
            <span className="flex-1 border-t border-gray-800 ml-2" />
          </button>
          <button
            onClick={() => { setNewShare({ ...newShare, path: currentPath }); setAddShareOpen(true); setSambaError(""); }}
            className="text-xs px-2 py-0.5 rounded bg-gray-800 hover:bg-gray-700 text-gray-300 hover:text-white transition-colors"
            title="Share current folder"
          >+</button>
        </div>

        {sambaOpen && (
          <div className="mt-3 space-y-2">
            {/* Setup warning */}
            {sambaSetupPresent === false && (
              <div className="rounded-lg bg-amber-950/40 border border-amber-700/40 px-3 py-2 text-xs text-amber-300 space-y-1.5">
                <p>anpan-os config not included in <code className="font-mono">/etc/samba/smb.conf</code>.</p>
                <button
                  onClick={() => void doSambaSetup()}
                  className="text-xs px-3 py-1 rounded bg-amber-700 hover:bg-amber-600 text-white transition-colors"
                >
                  Patch smb.conf
                </button>
              </div>
            )}

            {/* Error strip */}
            {sambaError && (
              <p className="text-xs text-red-400 break-all">{sambaError}</p>
            )}

            {/* Share list */}
            {shares.length === 0 && <p className="text-gray-600 text-xs">No shares configured.</p>}
            {shares.map((share) => (
              <div key={`${share.source}-${share.name}`} className="flex items-start justify-between gap-2 text-sm">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="font-medium text-gray-300 truncate">{share.name}</span>
                    {share.source === "external" && (
                      <span className="text-[9px] text-sky-500 border border-sky-500/30 rounded-full px-1.5 shrink-0">external</span>
                    )}
                    {share.readOnly && (
                      <span className="text-[9px] text-gray-500 border border-gray-600/30 rounded-full px-1.5 shrink-0">ro</span>
                    )}
                  </div>
                  <span className="text-gray-600 text-xs truncate block">{share.path}</span>
                </div>
                {share.source === "anpan" && (
                  <button
                    onClick={() => setRemoveShareTarget(share)}
                    className="text-xs text-red-500 hover:text-red-400 transition-colors shrink-0 mt-0.5"
                  >
                    Remove
                  </button>
                )}
              </div>
            ))}

            {/* Reload button */}
            {shares.some((s) => s.source === "anpan") && (
              <div className="flex justify-end pt-1">
                <button
                  onClick={() => void reloadSmbd()}
                  disabled={reloadingSmbd}
                  className="text-xs px-3 py-1 rounded bg-gray-800 hover:bg-gray-700 text-gray-300 hover:text-white transition-colors disabled:opacity-50"
                >
                  {reloadingSmbd ? "Reloading…" : "Reload smbd"}
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Add Samba share dialog */}
      {addShareOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
          onClick={(e) => { if (e.target === e.currentTarget) setAddShareOpen(false); }}
        >
          <div className="w-full max-w-md bg-gray-900 border border-gray-700 rounded-xl shadow-2xl">
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
              <h2 className="text-base font-semibold text-white">Add Samba Share</h2>
              <button onClick={() => setAddShareOpen(false)} className="text-gray-400 hover:text-white text-xl">✕</button>
            </div>
            <div className="px-5 py-4 space-y-3">
              {(["name", "path", "comment"] as const).map((field) => (
                <label key={field} className="block">
                  <span className="text-xs text-gray-400 block mb-1 capitalize">
                    {field === "comment" ? "Comment (optional)" : field === "name" ? "Share Name" : "Path"}
                  </span>
                  <input
                    value={newShare[field]}
                    onChange={(e) => setNewShare({ ...newShare, [field]: e.target.value })}
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-blue-500"
                  />
                </label>
              ))}
              <label className="flex items-center gap-2 text-sm text-gray-300">
                <input
                  type="checkbox"
                  checked={newShare.readOnly}
                  onChange={(e) => setNewShare({ ...newShare, readOnly: e.target.checked })}
                />
                Read only
              </label>
              {sambaError && <p className="text-xs text-red-400">{sambaError}</p>}
            </div>
            <div className="px-5 py-4 border-t border-gray-800 flex justify-end gap-2">
              <button
                onClick={() => setAddShareOpen(false)}
                className="px-4 py-2 rounded-lg text-sm text-gray-300 hover:text-white hover:bg-gray-800 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => void addShare()}
                className="px-4 py-2 rounded-lg text-sm font-medium bg-blue-600 hover:bg-blue-700 text-white transition-colors"
              >
                Add Share
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Remove share confirm */}
      <ConfirmDialog
        open={!!removeShareTarget}
        title="Remove Share"
        message={`Remove Samba share "${removeShareTarget?.name}"?`}
        confirmLabel="Remove"
        danger
        onConfirm={() => void removeShare()}
        onCancel={() => setRemoveShareTarget(null)}
      />
    </PrivilegeGuard>
  );
}
