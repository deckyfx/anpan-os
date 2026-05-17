import { useState } from "react";
import { RefreshCw, Trash2, Plus } from "lucide-react";
import { Dialog } from "../../components/Dialog";
import { useAppStoreStore } from "../../stores/appStoreStore";
import type { AppRepo } from "./types";

export function RepoManagerDialog() {
  const { repos, repoManagerOpen, setRepoManagerOpen, createRepo, updateRepo, deleteRepo, refreshRepo } =
    useAppStoreStore(s => ({
      repos:             s.repos,
      repoManagerOpen:   s.repoManagerOpen,
      setRepoManagerOpen: s.setRepoManagerOpen,
      createRepo:        s.createRepo,
      updateRepo:        s.updateRepo,
      deleteRepo:        s.deleteRepo,
      refreshRepo:       s.refreshRepo,
    }));

  const [newName, setNewName] = useState("");
  const [newUrl,  setNewUrl]  = useState("");
  const [addError,  setAddError]  = useState("");
  const [adding,    setAdding]    = useState(false);
  const [refreshing, setRefreshing] = useState<number | null>(null);
  const [deleting,   setDeleting]   = useState<number | null>(null);

  const handleAdd = async () => {
    setAddError("");
    if (!newName.trim() || !newUrl.trim()) { setAddError("Name and URL are required"); return; }
    setAdding(true);
    try {
      await createRepo(newName.trim(), newUrl.trim());
      setNewName("");
      setNewUrl("");
    } catch (e) {
      setAddError(e instanceof Error ? e.message : String(e));
    } finally {
      setAdding(false);
    }
  };

  const handleRefresh = async (id: number) => {
    setRefreshing(id);
    try {
      await refreshRepo(id);
    } finally {
      setRefreshing(null);
    }
  };

  const handleDelete = async (id: number) => {
    setDeleting(id);
    try {
      await deleteRepo(id);
    } finally {
      setDeleting(null);
    }
  };

  return (
    <Dialog
      open={repoManagerOpen}
      title="Manage Repositories"
      size="lg"
      onClose={() => setRepoManagerOpen(false)}
    >
      <div className="space-y-3">
        {/* Repo list */}
        {repos.length === 0 && (
          <p className="text-sm text-gray-600 py-4 text-center">No repositories configured.</p>
        )}
        {repos.map(repo => (
          <RepoRow
            key={repo.id}
            repo={repo}
            refreshing={refreshing === repo.id}
            deleting={deleting === repo.id}
            onToggle={(enabled) => void updateRepo(repo.id, { enabled })}
            onRefresh={() => void handleRefresh(repo.id)}
            onDelete={() => void handleDelete(repo.id)}
          />
        ))}

        {/* Add repo form */}
        <div className="border-t border-gray-800 pt-4 space-y-2">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Add Repository</p>
          <input
            type="text"
            placeholder="Name (e.g. My Store)"
            value={newName}
            onChange={e => setNewName(e.target.value)}
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 outline-none focus:border-gray-500"
          />
          <input
            type="text"
            placeholder="https://github.com/owner/repo"
            value={newUrl}
            onChange={e => setNewUrl(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") void handleAdd(); }}
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 outline-none focus:border-gray-500"
          />
          {addError && <p className="text-xs text-red-400">{addError}</p>}
          <button
            onClick={() => void handleAdd()}
            disabled={adding}
            className="flex items-center gap-2 px-3 py-2 text-sm font-medium bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors disabled:opacity-50"
          >
            {adding
              ? <span className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
              : <Plus size={14} />}
            Add
          </button>
        </div>
      </div>
    </Dialog>
  );
}

function RepoRow({ repo, refreshing, deleting, onToggle, onRefresh, onDelete }: {
  repo:       AppRepo;
  refreshing: boolean;
  deleting:   boolean;
  onToggle:   (enabled: boolean) => void;
  onRefresh:  () => void;
  onDelete:   () => void;
}) {
  return (
    <div className="flex items-center gap-3 bg-gray-800 rounded-lg px-3 py-2.5">
      {/* Toggle */}
      <button
        onClick={() => onToggle(!repo.enabled)}
        className={`w-9 h-5 rounded-full transition-colors shrink-0 relative ${
          repo.enabled ? "bg-blue-600" : "bg-gray-700"
        }`}
        title={repo.enabled ? "Disable" : "Enable"}
      >
        <span
          className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${
            repo.enabled ? "translate-x-4" : "translate-x-0.5"
          }`}
        />
      </button>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <p className="text-sm text-gray-200 truncate">{repo.name}</p>
        <p className="text-xs text-gray-500 truncate">{repo.url}</p>
      </div>

      {/* Actions */}
      <button
        onClick={onRefresh}
        disabled={refreshing || deleting}
        title="Refresh"
        className="p-1.5 text-gray-500 hover:text-white hover:bg-gray-700 rounded-lg transition-colors disabled:opacity-40"
      >
        <RefreshCw size={13} className={refreshing ? "animate-spin" : ""} />
      </button>
      <button
        onClick={onDelete}
        disabled={refreshing || deleting}
        title="Delete"
        className="p-1.5 text-gray-500 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-colors disabled:opacity-40"
      >
        {deleting
          ? <span className="w-3 h-3 border-2 border-red-400 border-t-transparent rounded-full animate-spin block" />
          : <Trash2 size={13} />}
      </button>
    </div>
  );
}
