import { useEffect, useMemo, useState } from "react";
import { Search, Settings, X } from "lucide-react";
import { useAppStoreStore } from "../../stores/appStoreStore";
import { AppCard } from "./AppCard";
import { AppDetailDialog } from "./AppDetailDialog";
import { RepoManagerDialog } from "./RepoManagerDialog";

export function AppStorePage({ onNavigate }: { onNavigate: (path: string) => void }) {
  const {
    repos, apps, fetchErrors, loadingApps, loadingRepos,
    searchQuery, selectedCategory, selectedRepoId,
    setSearchQuery, setSelectedCategory, setSelectedRepoId,
    setRepoManagerOpen, loadRepos, loadApps,
  } = useAppStoreStore();

  const [dismissedErrors, setDismissedErrors] = useState<Set<string>>(new Set());

  useEffect(() => {
    void loadRepos();
    void loadApps();
  }, []);

  // Derived categories from all apps
  const categories = useMemo(() => {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const app of apps) {
      if (app.category && !seen.has(app.category)) {
        seen.add(app.category);
        result.push(app.category);
      }
    }
    return result.sort();
  }, [apps]);

  // Repo label map for the filter dropdown
  const repoLabel = useMemo(() => {
    const m = new Map<number, string>();
    for (const r of repos) m.set(r.id, r.name);
    return m;
  }, [repos]);

  // Filtered apps
  const filteredApps = useMemo(() => {
    let list = apps;
    if (selectedRepoId !== null) list = list.filter(a => a.repoId === selectedRepoId);
    if (selectedCategory)         list = list.filter(a => a.category === selectedCategory);
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      list = list.filter(a =>
        a.title.toLowerCase().includes(q) ||
        a.tagline.toLowerCase().includes(q) ||
        a.description.toLowerCase().includes(q),
      );
    }
    return list;
  }, [apps, selectedRepoId, selectedCategory, searchQuery]);

  const visibleErrors = fetchErrors.filter(e => !dismissedErrors.has(e));

  return (
    <div className="flex flex-col h-screen bg-gray-950 text-white overflow-hidden">
      {/* Toolbar */}
      <div className="shrink-0 border-b border-gray-800 px-5 py-3 flex items-center gap-3 flex-wrap">
        <h1 className="text-sm font-semibold text-white shrink-0">App Store</h1>

        {/* Search */}
        <div className="relative flex-1 min-w-40 max-w-72">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 pointer-events-none" />
          <input
            type="text"
            placeholder="Search apps…"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            className="w-full bg-gray-800 border border-gray-700 rounded-lg pl-8 pr-3 py-1.5 text-sm text-white placeholder-gray-600 outline-none focus:border-gray-500"
          />
        </div>

        {/* Category filter */}
        <select
          value={selectedCategory ?? ""}
          onChange={e => setSelectedCategory(e.target.value || null)}
          className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-white outline-none focus:border-gray-500 max-w-40"
        >
          <option value="">All categories</option>
          {categories.map(c => <option key={c} value={c}>{c}</option>)}
        </select>

        {/* Repo filter */}
        <select
          value={selectedRepoId ?? ""}
          onChange={e => setSelectedRepoId(e.target.value ? Number(e.target.value) : null)}
          className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-white outline-none focus:border-gray-500 max-w-48"
        >
          <option value="">All repos</option>
          {repos.filter(r => r.enabled).map(r => (
            <option key={r.id} value={r.id}>{r.name}</option>
          ))}
        </select>

        {/* Manage repos */}
        <button
          onClick={() => setRepoManagerOpen(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-gray-400 hover:text-white hover:bg-gray-800 border border-gray-700 rounded-lg transition-colors shrink-0"
        >
          <Settings size={13} />
          Manage
        </button>

        {/* App count */}
        <span className="text-xs text-gray-600 shrink-0 ml-auto">
          {filteredApps.length} app{filteredApps.length !== 1 ? "s" : ""}
        </span>
      </div>

      {/* Error banners */}
      {visibleErrors.length > 0 && (
        <div className="shrink-0 px-5 pt-3 space-y-2">
          {visibleErrors.map(err => (
            <div key={err} className="flex items-center gap-3 bg-red-500/10 border border-red-500/30 rounded-lg px-4 py-2">
              <p className="text-xs text-red-300 flex-1">{err}</p>
              <button
                onClick={() => setDismissedErrors(p => new Set([...p, err]))}
                aria-label="Dismiss error"
                className="text-red-400 hover:text-white"
              >
                <X size={13} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Content area */}
      <div className="flex-1 overflow-y-auto px-5 py-4">
        {(loadingApps || loadingRepos) && apps.length === 0 ? (
          // Loading skeleton
          <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))" }}>
            {Array.from({ length: 12 }).map((_, i) => (
              <div key={i} className="bg-gray-900 border border-gray-800 rounded-xl p-4 animate-pulse">
                <div className="flex items-start gap-3">
                  <div className="w-14 h-14 rounded-xl bg-gray-800 shrink-0" />
                  <div className="flex-1 space-y-2 pt-1">
                    <div className="h-3 bg-gray-800 rounded w-3/4" />
                    <div className="h-2 bg-gray-800 rounded w-full" />
                    <div className="h-2 bg-gray-800 rounded w-2/3" />
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : filteredApps.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <span className="text-4xl mb-4">📭</span>
            <p className="text-gray-500 text-sm">
              {apps.length === 0 ? "No apps loaded. Check your repos and network connection." : "No apps match your filters."}
            </p>
            {(searchQuery || selectedCategory || selectedRepoId !== null) && (
              <button
                onClick={() => { setSearchQuery(""); setSelectedCategory(null); setSelectedRepoId(null); }}
                className="mt-3 text-xs text-blue-400 hover:text-blue-300"
              >
                Clear filters
              </button>
            )}
          </div>
        ) : (
          <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))" }}>
            {filteredApps.map(app => <AppCard key={app.id} app={app} />)}
          </div>
        )}
      </div>

      {/* Dialogs */}
      <AppDetailDialog />
      <RepoManagerDialog />
    </div>
  );
}
