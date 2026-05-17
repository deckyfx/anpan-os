import { create } from "zustand";
import { api } from "../lib/api";
import type { AppRepo, StoreApp } from "../pages/store/types";

// Eden Treaty types the repos endpoint with a function overload for path params.
// We use `as unknown as` to access the parameterised form without duplicating the full type.
type RepoEndpoint = {
  patch: (body: { name?: string; enabled?: boolean }) => Promise<{ data: unknown }>;
  delete: () => Promise<{ data: unknown }>;
  refresh: { post: () => Promise<{ data: unknown }> };
};
type AppsRepoEndpoint = (params: { appName: string | number }) => {
  compose: { get: () => Promise<{ data: unknown }> };
};

function repoById(id: number): RepoEndpoint {
  return (api.api["app-store"].repos as unknown as (p: { id: string | number }) => RepoEndpoint)({ id });
}
function appByIds(repoId: number, appName: string) {
  const repoSegment = (api.api["app-store"].apps as unknown as (p: { repoId: string | number }) => AppsRepoEndpoint)({ repoId });
  return repoSegment({ appName }).compose;
}

interface AppStoreState {
  // ── Data ──────────────────────────────────────────────────────────────────
  repos:            AppRepo[];
  apps:             StoreApp[];
  fetchErrors:      string[];
  loadingApps:      boolean;
  loadingRepos:     boolean;

  // ── Filter UI ─────────────────────────────────────────────────────────────
  searchQuery:      string;
  selectedCategory: string | null;
  selectedRepoId:   number | null;

  // ── Dialogs ───────────────────────────────────────────────────────────────
  detailApp:        StoreApp | null;
  repoManagerOpen:  boolean;

  // ── Install flow ──────────────────────────────────────────────────────────
  installApp:       StoreApp | null;
  installContent:   string | null;

  // ── Actions ───────────────────────────────────────────────────────────────
  loadRepos():                                        Promise<void>;
  loadApps():                                         Promise<void>;
  refreshRepo(id: number):                            Promise<void>;
  createRepo(name: string, url: string):              Promise<void>;
  updateRepo(id: number, data: Partial<Pick<AppRepo, "name" | "enabled">>): Promise<void>;
  deleteRepo(id: number):                             Promise<void>;
  setSearchQuery(q: string):                          void;
  setSelectedCategory(cat: string | null):            void;
  setSelectedRepoId(id: number | null):               void;
  setDetailApp(app: StoreApp | null):                 void;
  setRepoManagerOpen(open: boolean):                  void;
  /** Fetch the compose content for an app and prime the install flow. */
  startInstall(app: StoreApp):                        Promise<void>;
  clearInstall():                                     void;
}

export const useAppStoreStore = create<AppStoreState>((set, get) => ({
  repos:            [],
  apps:             [],
  fetchErrors:      [],
  loadingApps:      false,
  loadingRepos:     false,
  searchQuery:      "",
  selectedCategory: null,
  selectedRepoId:   null,
  detailApp:        null,
  repoManagerOpen:  false,
  installApp:       null,
  installContent:   null,

  async loadRepos() {
    set({ loadingRepos: true });
    try {
      const { data } = await api.api["app-store"].repos.get();
      if (Array.isArray(data)) set({ repos: data as unknown as AppRepo[] });
    } catch (e) {
      set({ fetchErrors: [e instanceof Error ? e.message : String(e)] });
    } finally {
      set({ loadingRepos: false });
    }
  },

  async loadApps() {
    set({ loadingApps: true, fetchErrors: [] });
    try {
      const { data } = await api.api["app-store"].apps.get();
      if (data && typeof data === "object" && "apps" in data) {
        const d = data as { apps: StoreApp[]; errors: string[] };
        set({ apps: d.apps, fetchErrors: d.errors });
      }
    } catch (e) {
      set({ fetchErrors: [e instanceof Error ? e.message : String(e)] });
    } finally {
      set({ loadingApps: false });
    }
  },

  async refreshRepo(id: number) {
    await repoById(id).refresh.post();
    await get().loadApps();
  },

  async createRepo(name: string, url: string) {
    await api.api["app-store"].repos.post({ name, url });
    await get().loadRepos();
  },

  async updateRepo(id: number, data: Partial<Pick<AppRepo, "name" | "enabled">>) {
    await repoById(id).patch(data);
    await get().loadRepos();
    if (data.enabled !== undefined) await get().loadApps();
  },

  async deleteRepo(id: number) {
    await repoById(id).delete();
    await get().loadRepos();
    await get().loadApps();
  },

  setSearchQuery: (q) => set({ searchQuery: q }),
  setSelectedCategory: (cat) => set({ selectedCategory: cat }),
  setSelectedRepoId: (id) => set({ selectedRepoId: id }),
  setDetailApp: (app) => set({ detailApp: app }),
  setRepoManagerOpen: (open) => set({ repoManagerOpen: open }),

  async startInstall(app: StoreApp) {
    set({ installApp: app, installContent: null });
    try {
      const { data } = await appByIds(app.repoId, app.appName).get();
      const content = (data as { content?: string } | null)?.content ?? "";
      set({ installContent: content });
    } catch (e) {
      set({ installApp: null, installContent: null });
      throw e;
    }
  },

  clearInstall: () => set({ installApp: null, installContent: null }),
}));
