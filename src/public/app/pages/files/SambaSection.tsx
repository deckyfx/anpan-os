import { useFileStore } from "../../stores/fileStore";
import { ConfirmDialog } from "../../components/ConfirmDialog";

// ─── Samba Section ────────────────────────────────────────────────────────────

export function SambaSection() {
  const {
    currentPath,
    shares, sambaOpen, removeShareTarget, addShareOpen, newShare, reloadingSmbd,
    setSambaOpen, setRemoveShareTarget, setAddShareOpen, setNewShare,
    addShare, removeShare, reloadSmbd,
  } = useFileStore();

  return (
    <>
      <div className="border-t border-gray-800 px-5 py-3">
        <div className="flex items-center gap-2 text-sm text-gray-400">
          <button
            onClick={() => setSambaOpen(!sambaOpen)}
            className="flex items-center gap-2 flex-1 hover:text-white transition-colors text-left"
          >
            <span className={`transition-transform ${sambaOpen ? "rotate-90" : ""}`}>›</span>
            <span>Samba Shares</span>
            <span className="flex-1 border-t border-gray-800 ml-2" />
          </button>
          <button
            onClick={() => { setNewShare({ ...newShare, path: currentPath }); setAddShareOpen(true); }}
            className="text-xs px-2 py-0.5 rounded bg-gray-800 hover:bg-gray-700 text-gray-300 hover:text-white transition-colors"
          >+</button>
        </div>
        {sambaOpen && (
          <div className="mt-3 space-y-2">
            {shares.length === 0 && <p className="text-gray-600 text-xs">No shares configured.</p>}
            {shares.map((share) => (
              <div key={share.name} className="flex items-center justify-between gap-2 text-sm">
                <div className="flex-1 min-w-0">
                  <span className="font-medium text-gray-300">{share.name}</span>
                  <span className="text-gray-600 ml-2 truncate">{share.path}</span>
                </div>
                <button onClick={() => setRemoveShareTarget(share)} className="text-xs text-red-500 hover:text-red-400 transition-colors shrink-0">Remove</button>
              </div>
            ))}
            {shares.length > 0 && (
              <div className="flex justify-end pt-1">
                <button onClick={reloadSmbd} disabled={reloadingSmbd}
                  className="text-xs px-3 py-1 rounded bg-gray-800 hover:bg-gray-700 text-gray-300 hover:text-white transition-colors disabled:opacity-50">
                  {reloadingSmbd ? "Reloading…" : "Reload smbd"}
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Add Samba share */}
      {addShareOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
          onClick={(e) => { if (e.target === e.currentTarget) setAddShareOpen(false); }}>
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
                  <input value={newShare[field]} onChange={(e) => setNewShare({ ...newShare, [field]: e.target.value })}
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-blue-500" />
                </label>
              ))}
              <label className="flex items-center gap-2 text-sm text-gray-300">
                <input type="checkbox" checked={newShare.readOnly} onChange={(e) => setNewShare({ ...newShare, readOnly: e.target.checked })} />
                Read only
              </label>
            </div>
            <div className="px-5 py-4 border-t border-gray-800 flex justify-end gap-2">
              <button onClick={() => setAddShareOpen(false)} className="px-4 py-2 rounded-lg text-sm text-gray-300 hover:text-white hover:bg-gray-800 transition-colors">Cancel</button>
              <button onClick={addShare} className="px-4 py-2 rounded-lg text-sm font-medium bg-blue-600 hover:bg-blue-700 text-white transition-colors">Add Share</button>
            </div>
          </div>
        </div>
      )}

      {/* Remove share confirm */}
      <ConfirmDialog open={!!removeShareTarget} title="Remove Share"
        message={`Remove Samba share "${removeShareTarget?.name}"?`}
        confirmLabel="Remove" danger onConfirm={removeShare} onCancel={() => setRemoveShareTarget(null)} />
    </>
  );
}
