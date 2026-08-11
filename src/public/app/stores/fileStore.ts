import { create } from "zustand";
import { api } from "../lib/api";
import type { FileEntry, ViewMode, UploadItem, CtxMenu, SambaShare, FileBrowserConfig } from "../pages/files/types";
import { normalizePath, parentPath } from "../pages/files/helpers";
import { useToastStore } from "./toastStore";

function debounce<T extends unknown[]>(fn: (...args: T) => void, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (...args: T) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

const SHOW_HIDDEN_KEY = "anpan.files.showHidden";

/** Persisted dotfile preference. Defaults to hiding them, as every file manager does. */
function readShowHidden(): boolean {
  try {
    return localStorage.getItem(SHOW_HIDDEN_KEY) === "1";
  } catch {
    return false;   // private mode / storage disabled
  }
}

/**
 * The entries a user can currently see.
 *
 * Everything acting on "all files" — select-all above all — has to go through this, or it
 * would reach dotfiles that are not on screen and cannot be deselected.
 */
export function visibleEntries(entries: FileEntry[], showHidden: boolean): FileEntry[] {
  return showHidden ? entries : entries.filter(e => !e.name.startsWith("."));
}

interface NavHistory {
  stack: string[];
  idx:   number;
}

interface NewShare {
  name:     string;
  path:     string;
  comment:  string;
  readOnly: boolean;
  guestOk:  boolean;
}

interface FileState {
  // ── Navigation ────────────────────────────────────────────────────────────
  currentPath:  string;
  addressValue: string;
  entries:      FileEntry[];
  loadingDir:   boolean;
  navError:     string;
  navHistory:   NavHistory;
  homePath:     string;

  // ── Preview ───────────────────────────────────────────────────────────────
  drawerEntry:  FileEntry | null;
  fileContent:  string;
  fileBinary:   boolean;
  saving:       boolean;
  saveMsg:      string;

  // ── Rename ────────────────────────────────────────────────────────────────
  renamingPath: string | null;
  renameValue:  string;

  // ── Delete ────────────────────────────────────────────────────────────────
  deleteTargets: FileEntry[];

  // ── New folder ────────────────────────────────────────────────────────────
  creatingFolder: boolean;
  newFolderName:  string;

  // ── View / selection ──────────────────────────────────────────────────────
  viewMode:      ViewMode;
  /** Show dotfiles. Off by default, and remembered across sessions. */
  showHidden:    boolean;
  selectedPaths: Set<string>;

  // ── Context menu ──────────────────────────────────────────────────────────
  ctxMenu: CtxMenu | null;

  // ── Upload ────────────────────────────────────────────────────────────────
  uploadItems: UploadItem[];

  // ── ChMod ─────────────────────────────────────────────────────────────────
  chmodTarget: FileEntry | null;
  chmodValue:  string;

  // ── Info ──────────────────────────────────────────────────────────────────
  infoTarget: FileEntry | null;

  // ── Archive ───────────────────────────────────────────────────────────────
  archiveDialog: boolean;
  archiveName:   string;
  archivePaths:  string[];

  // ── Clipboard / copy-move ────────────────────────────────────────────────
  clipboard:        { op: "copy" | "cut"; paths: string[] } | null;
  copyMoveProgress: { title: string; logs: string[]; done: boolean; error: string } | null;

  // ── Folder sizes ─────────────────────────────────────────────────────────
  folderSizes: Record<string, string>;

  // ── Samba ─────────────────────────────────────────────────────────────────
  shares:             SambaShare[];
  sambaOpen:          boolean;
  removeShareTarget:  SambaShare | null;
  addShareOpen:       boolean;
  newShare:           NewShare;
  reloadingSmbd:      boolean;
  /** null = not yet checked, true/false = include present in smb.conf */
  sambaSetupPresent:  boolean | null;
  sambaError:         string;

  // ── Cross-page navigation ─────────────────────────────────────────────────
  /** Set by stacksStore before navigating to /files; FilesPage reads + clears it on mount. */
  pendingNavigatePath: string | null;

  // ── File browser config ───────────────────────────────────────────────────
  fileBrowserConfig:     FileBrowserConfig;
  configLoaded:          boolean;
  loadFileBrowserConfig: () => Promise<void>;
  saveFileBrowserConfig: (patch: Partial<FileBrowserConfig>) => Promise<void>;
  toggleBookmark:        (path: string, name?: string) => Promise<void>;
  updateLastPath:        (path: string) => void;

  // ── Init ──────────────────────────────────────────────────────────────────
  initialized: boolean;

  // ── Actions (setters) ─────────────────────────────────────────────────────
  initialize:       () => void;
  loadDirContent:   (path: string) => Promise<boolean>;
  navigateTo:       (path: string) => Promise<void>;
  goBack:           () => void;
  goForward:        () => void;

  // File ops
  openFile:         (entry: FileEntry) => Promise<void>;
  saveFile:         () => Promise<void>;
  commitRename:     (entry: FileEntry) => Promise<void>;
  confirmDelete:    () => Promise<void>;
  setDeleteTargets: (entries: FileEntry[]) => void;
  commitNewFolder:  () => Promise<void>;
  handleUpload:     (files: FileList | null) => void;
  handleChmod:      () => Promise<void>;
  handleArchive:    () => Promise<void>;
  handleExtract:    (entry: FileEntry) => Promise<void>;

  // Clipboard / copy-move
  setClipboard:          (op: "copy" | "cut", paths: string[]) => void;
  clearClipboard:        () => void;
  pasteClipboard:        (destination: string) => Promise<void>;
  calculateFolderSize:   (path: string) => Promise<void>;
  setCopyMoveProgress:   (v: FileState["copyMoveProgress"]) => void;

  // Samba
  loadShares:       () => Promise<void>;
  checkSambaSetup:  () => Promise<void>;
  doSambaSetup:     () => Promise<void>;
  doSambaUnpatch:   () => Promise<void>;
  doSambaRebuild:   () => Promise<void>;
  addShare:         () => Promise<void>;
  removeShare:      () => Promise<void>;
  takeOverShare:    (name: string) => Promise<void>;
  editShare:        (name: string, patch: { comment?: string; readOnly?: boolean; guestOk?: boolean; browseable?: boolean }) => Promise<void>;
  reloadSmbd:       () => Promise<void>;

  // Selection
  toggleSelect:    (path: string) => void;
  toggleSelectAll: () => void;
  toggleShowHidden: () => void;

  // Setters
  setAddressValue:      (v: string) => void;
  setNavError:          (v: string) => void;
  setDrawerEntry:       (e: FileEntry | null) => void;
  setFileContent:       (v: string) => void;
  setSaveMsg:           (v: string) => void;
  setRenamingPath:      (v: string | null) => void;
  setRenameValue:       (v: string) => void;
  setDeleteTarget:      (e: FileEntry | null) => void; // kept for legacy single-item callers
  setCreatingFolder:    (v: boolean) => void;
  setNewFolderName:     (v: string) => void;
  setViewMode:          (v: ViewMode) => void;
  setCtxMenu:           (m: CtxMenu | null) => void;
  setUploadItems:       (items: UploadItem[]) => void;
  setChmodTarget:       (e: FileEntry | null) => void;
  setChmodValue:        (v: string) => void;
  setInfoTarget:        (e: FileEntry | null) => void;
  setArchiveDialog:     (v: boolean) => void;
  setArchiveName:       (v: string) => void;
  setArchivePaths:      (p: string[]) => void;
  setSambaOpen:         (v: boolean) => void;
  setRemoveShareTarget: (s: SambaShare | null) => void;
  setAddShareOpen:      (v: boolean) => void;
  setNewShare:          (s: NewShare) => void;
  setSambaError:        (v: string) => void;
  setPendingPath:       (path: string | null) => void;
}

export const useFileStore = create<FileState>((set, get) => ({
  currentPath:  "/",
  addressValue: "/",
  entries:      [],
  loadingDir:   false,
  navError:     "",
  navHistory:   { stack: [], idx: -1 },
  homePath:     "/",

  drawerEntry:  null,
  fileContent:  "",
  fileBinary:   false,
  saving:       false,
  saveMsg:      "",

  renamingPath: null,
  renameValue:  "",

  deleteTargets: [],

  creatingFolder: false,
  newFolderName:  "",

  viewMode:      "list",
  showHidden:    readShowHidden(),
  selectedPaths: new Set<string>(),

  ctxMenu: null,

  uploadItems: [],

  chmodTarget: null,
  chmodValue:  "",

  infoTarget: null,

  archiveDialog: false,
  archiveName:   "",
  archivePaths:  [],

  clipboard:        null,
  copyMoveProgress: null,
  folderSizes:      {},

  shares:             [],
  sambaOpen:          false,
  removeShareTarget:  null,
  addShareOpen:       false,
  newShare:           { name: "", path: "/", comment: "", readOnly: false, guestOk: true },
  reloadingSmbd:      false,
  sambaSetupPresent:  null,
  sambaError:         "",

  pendingNavigatePath: null,

  fileBrowserConfig: { startPath: "", persistLastPath: false, lastPath: "", bookmarks: [] },
  configLoaded: false,

  initialized: false,

  // ── Init ─────────────────────────────────────────────────────────────────

  initialize: () => {
    if (get().initialized) return;
    set({ initialized: true });

    const store = get();

    api.api.files.home.get()
      .then(async ({ data }) => {
        const homePath = (data as { path: string })?.path ?? "/";
        set({ homePath });

        await store.loadFileBrowserConfig();
        const cfg = get().fileBrowserConfig;

        // Validate configured paths before navigating: attempt to list the
        // directory; on failure fall back to homePath and warn the user.
        const tryNavigate = async (path: string, label: string): Promise<boolean> => {
          const ok = await get().loadDirContent(path);
          if (!ok) {
            useToastStore.getState().push(`Configured ${label} "${path}" is inaccessible — returning to home`, "error");
          }
          return ok;
        };

        if (cfg.persistLastPath && cfg.lastPath) {
          if (await tryNavigate(cfg.lastPath, "last path")) return;
        } else if (cfg.startPath) {
          if (await tryNavigate(cfg.startPath, "start path")) return;
        }
        return get().navigateTo(homePath);
      })
      .catch(() => get().navigateTo("/"));

    void get().loadShares();
    void get().checkSambaSetup();
  },

  // ── Navigation ───────────────────────────────────────────────────────────

  loadDirContent: async (path) => {
    const trimmed = normalizePath(path.trim());
    if (!trimmed) return false;
    set({ loadingDir: true });
    try {
      const { data, error } = await api.api.files.list.get({ query: { path: trimmed } });
      if (error) {
        set({ navError: (error.value as { error?: string })?.error ?? `Cannot open "${trimmed}"` });
        return false;
      }
      const data2 = data as unknown as FileEntry[];
      data2.sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      set({ entries: data2, currentPath: trimmed, addressValue: trimmed, selectedPaths: new Set() });
      return true;
    } catch (e) {
      set({ navError: String(e) });
      return false;
    } finally {
      set({ loadingDir: false });
    }
  },

  navigateTo: async (path) => {
    const trimmed = normalizePath(path.trim());
    const ok = await get().loadDirContent(trimmed);
    if (!ok) return;
    set((state) => {
      const { stack, idx } = state.navHistory;
      if (stack[idx] === trimmed) return state;
      const newStack = [...stack.slice(0, idx + 1), trimmed];
      return { navHistory: { stack: newStack, idx: newStack.length - 1 } };
    });
    get().updateLastPath(trimmed);
  },

  goBack: () => {
    const { navHistory, loadDirContent } = get();
    if (navHistory.idx <= 0) return;
    const newIdx = navHistory.idx - 1;
    const target = navHistory.stack[newIdx];
    if (target !== undefined) void loadDirContent(target);
    set({ navHistory: { ...navHistory, idx: newIdx } });
  },

  goForward: () => {
    const { navHistory, loadDirContent } = get();
    if (navHistory.idx >= navHistory.stack.length - 1) return;
    const newIdx = navHistory.idx + 1;
    const target = navHistory.stack[newIdx];
    if (target !== undefined) void loadDirContent(target);
    set({ navHistory: { ...navHistory, idx: newIdx } });
  },

  loadShares: async () => {
    try {
      // Load all shares (our + external) for display in the file browser.
      const { data } = await (api.api.samba as unknown as { "all-shares": { get: () => Promise<{ data: unknown }> } })["all-shares"].get();
      if (data) set({ shares: data as unknown as SambaShare[] });
    } catch { /* ignore */ }
  },

  checkSambaSetup: async () => {
    try {
      const { data } = await (api.api.samba as unknown as { "setup-status": { get: () => Promise<{ data: unknown }> } })["setup-status"].get();
      const d = data as { present?: boolean } | null;
      set({ sambaSetupPresent: d?.present ?? false });
    } catch { /* ignore */ }
  },

  doSambaSetup: async () => {
    try {
      const { data } = await (api.api.samba as unknown as { setup: { post: () => Promise<{ data: unknown }> } }).setup.post();
      const d = data as { ok?: boolean; error?: string } | null;
      if (d?.ok) {
        set({ sambaSetupPresent: true, sambaError: "" });
      } else {
        set({ sambaError: d?.error ?? "Setup failed" });
      }
    } catch (e) {
      set({ sambaError: e instanceof Error ? e.message : "Setup failed" });
    }
  },

  doSambaUnpatch: async () => {
    try {
      const { data } = await (api.api.samba as unknown as { setup: { delete: () => Promise<{ data: unknown }> } }).setup.delete();
      const d = data as { ok?: boolean; error?: string } | null;
      if (d?.ok) {
        set({ sambaSetupPresent: false, sambaError: "" });
      } else {
        set({ sambaError: d?.error ?? "Unpatch failed" });
      }
    } catch (e) {
      set({ sambaError: e instanceof Error ? e.message : "Unpatch failed" });
    }
  },

  doSambaRebuild: async () => {
    try {
      const { data } = await (api.api.samba as unknown as { rebuild: { post: () => Promise<{ data: unknown }> } }).rebuild.post();
      const d = data as { ok?: boolean; error?: string } | null;
      if (!d?.ok) {
        set({ sambaError: d?.error ?? "Rebuild failed" });
      } else {
        set({ sambaError: "" });
      }
    } catch (e) {
      set({ sambaError: e instanceof Error ? e.message : "Rebuild failed" });
    }
  },

  // ── File ops ─────────────────────────────────────────────────────────────

  openFile: async (entry) => {
    set({ drawerEntry: entry, fileContent: "", fileBinary: false, saveMsg: "" });
    try {
      const { data } = await api.api.files.read.get({ query: { path: entry.path } });
      if (data) {
        const d = data as unknown as { content: string; binary: boolean };
        set({ fileBinary: d.binary, fileContent: d.binary ? "" : d.content });
      }
    } catch { /* show download-only */ }
  },

  saveFile: async () => {
    const { drawerEntry, fileContent } = get();
    if (!drawerEntry) return;
    set({ saving: true, saveMsg: "" });
    try {
      const { error } = await api.api.files.write.put({ path: drawerEntry.path, content: fileContent });
      set({ saveMsg: error ? "Error saving" : "Saved" });
    } catch {
      set({ saveMsg: "Error saving" });
    } finally {
      set({ saving: false });
    }
  },

  commitRename: async (entry) => {
    const { renameValue, currentPath, loadDirContent } = get();
    if (!renameValue.trim() || renameValue === entry.name) { set({ renamingPath: null }); return; }
    const to = (currentPath.endsWith("/") ? currentPath : currentPath + "/") + renameValue.trim();
    try {
      const { error } = await api.api.files.rename.post({ from: entry.path, to });
      if (!error) await loadDirContent(currentPath);
    } catch { /* ignore */ }
    set({ renamingPath: null });
  },

  confirmDelete: async () => {
    const { deleteTargets, currentPath, loadDirContent } = get();
    if (!deleteTargets.length) return;
    await Promise.allSettled(deleteTargets.map(e => api.api.files.delete.delete({ path: e.path })));
    await loadDirContent(currentPath);
    set({ deleteTargets: [], selectedPaths: new Set() });
  },

  commitNewFolder: async () => {
    const { newFolderName, currentPath, loadDirContent } = get();
    if (!newFolderName.trim()) { set({ creatingFolder: false }); return; }
    const path = (currentPath.endsWith("/") ? currentPath : currentPath + "/") + newFolderName.trim();
    try {
      const { error } = await api.api.files.mkdir.post({ path });
      if (!error) await loadDirContent(currentPath);
    } catch { /* ignore */ }
    set({ creatingFolder: false, newFolderName: "" });
  },

  handleUpload: (files) => {
    if (!files?.length) return;
    const fileArray  = Array.from(files);
    const uploadPath = get().currentPath;
    set({ uploadItems: fileArray.map(f => ({ name: f.name, loaded: 0, total: f.size, done: false, error: false })) });
    let idx = 0;
    const next = () => {
      if (idx >= fileArray.length) {
        setTimeout(() => {
          void get().loadDirContent(uploadPath);
          set({ uploadItems: [] });
        }, 800);
        return;
      }
      const file = fileArray[idx]!; const i = idx++;
      const xhr = new XMLHttpRequest(); const fd = new FormData();
      fd.append("file", file);
      xhr.upload.onprogress = (e) => {
        if (!e.lengthComputable) return;
        set((s) => ({ uploadItems: s.uploadItems.map((it, j) => j === i ? { ...it, loaded: e.loaded, total: e.total } : it) }));
      };
      xhr.onload = () => {
        const ok = xhr.status >= 200 && xhr.status < 300;
        set((s) => ({ uploadItems: s.uploadItems.map((it, j) => j === i ? { ...it, loaded: it.total, done: true, error: !ok } : it) }));
        next();
      };
      xhr.onerror = () => {
        set((s) => ({ uploadItems: s.uploadItems.map((it, j) => j === i ? { ...it, done: true, error: true } : it) }));
        next();
      };
      xhr.open("POST", `/api/files/upload?path=${encodeURIComponent(uploadPath)}`);
      xhr.send(fd);
    };
    next();
  },

  handleChmod: async () => {
    const { chmodTarget, chmodValue, currentPath, loadDirContent } = get();
    if (!chmodTarget) return;
    try {
      const { error } = await api.api.files.chmod.post({ path: chmodTarget.path, mode: chmodValue });
      if (!error) { await loadDirContent(currentPath); set({ chmodTarget: null }); }
    } catch { /* ignore */ }
  },

  handleArchive: async () => {
    const { archivePaths, currentPath, archiveName, loadDirContent } = get();
    if (!archivePaths.length) return;
    const dest = (currentPath.endsWith("/") ? currentPath : currentPath + "/") + archiveName;
    try {
      await api.api.files.zip.post({ paths: archivePaths, dest });
      await loadDirContent(currentPath);
    } catch { /* ignore */ }
    set({ archiveDialog: false });
  },

  handleExtract: async (entry) => {
    const { currentPath, loadDirContent } = get();
    try {
      await api.api.files.unzip.post({ path: entry.path, dest: currentPath });
      await loadDirContent(currentPath);
    } catch { /* ignore */ }
  },

  // ── Clipboard / copy-move ────────────────────────────────────────────────

  /** Store a set of paths in the clipboard for a subsequent copy or cut operation. */
  setClipboard: (op, paths) => set({ clipboard: { op, paths } }),

  /** Clear the clipboard state. */
  clearClipboard: () => set({ clipboard: null }),

  /**
   * Execute the pending clipboard operation (copy or move) into `destination`,
   * streaming progress via SSE and refreshing the destination directory on completion.
   */
  pasteClipboard: async (destination) => {
    const { clipboard, loadDirContent } = get();
    if (!clipboard) return;

    const title = clipboard.op === "copy"
      ? `Copying ${clipboard.paths.length} item(s)…`
      : `Moving ${clipboard.paths.length} item(s)…`;

    set({ copyMoveProgress: { title, logs: [], done: false, error: "" } });

    type SSEEvent = { data: { log?: string; ok?: boolean; error?: string } };

    try {
      const endpoint = clipboard.op === "copy"
        ? (api.api.files as unknown as { copy: { post: (b: { sources: string[]; destination: string }) => Promise<{ data: unknown; error: unknown }> } }).copy
        : (api.api.files as unknown as { move: { post: (b: { sources: string[]; destination: string }) => Promise<{ data: unknown; error: unknown }> } }).move;

      const { data, error } = await endpoint.post({ sources: clipboard.paths, destination });
      if (error) {
        set((s) => ({ copyMoveProgress: s.copyMoveProgress ? { ...s.copyMoveProgress, done: true, error: (error as { value?: { error?: string } }).value?.error ?? "Request failed" } : null }));
        return;
      }
      if (!data) {
        set((s) => ({ copyMoveProgress: s.copyMoveProgress ? { ...s.copyMoveProgress, done: true, error: "No stream received" } : null }));
        return;
      }

      for await (const event of data as AsyncIterable<SSEEvent>) {
        const m = event.data;
        if (!m) continue;
        if (m.log !== undefined) {
          set((s) => ({ copyMoveProgress: s.copyMoveProgress ? { ...s.copyMoveProgress, logs: [...s.copyMoveProgress.logs, m.log!] } : null }));
        } else if (m.ok) {
          if (clipboard.op === "cut") set({ clipboard: null });
          await loadDirContent(destination);
          set((s) => ({ copyMoveProgress: s.copyMoveProgress ? { ...s.copyMoveProgress, done: true } : null }));
        } else if (m.error) {
          set((s) => ({ copyMoveProgress: s.copyMoveProgress ? { ...s.copyMoveProgress, done: true, error: m.error! } : null }));
        }
      }
    } catch (err) {
      set((s) => ({ copyMoveProgress: s.copyMoveProgress ? { ...s.copyMoveProgress, done: true, error: err instanceof Error ? err.message : String(err) } : null }));
    }
  },

  /** Fetch folder size via `du -sh` and cache the result in `folderSizes`. */
  calculateFolderSize: async (path) => {
    try {
      const { data } = await (api.api.files as unknown as { size: { get: (q: { query: { path: string } }) => Promise<{ data: unknown }> } }).size.get({ query: { path } });
      const size = (data as { size?: string } | null)?.size;
      if (size) set((s) => ({ folderSizes: { ...s.folderSizes, [path]: size } }));
    } catch { /* ignore */ }
  },

  /** Directly set (or clear) the copy/move progress dialog state. */
  setCopyMoveProgress: (v) => set({ copyMoveProgress: v }),

  // ── File browser config ───────────────────────────────────────────────────

  loadFileBrowserConfig: async () => {
    try {
      const { data } = await (api.api.files as unknown as { config: { get: () => Promise<{ data: unknown }> } }).config.get();
      if (data) {
        set({ fileBrowserConfig: data as FileBrowserConfig, configLoaded: true });
      }
    } catch { /* ignore */ }
  },

  saveFileBrowserConfig: async (patch) => {
    const prev = get().fileBrowserConfig;
    set((s) => ({ fileBrowserConfig: { ...s.fileBrowserConfig, ...patch } }));
    try {
      await (api.api.files as unknown as { config: { patch: (b: Partial<FileBrowserConfig>) => Promise<{ data: unknown }> } }).config.patch(patch);
    } catch {
      set({ fileBrowserConfig: prev });
      useToastStore.getState().push("Failed to save file browser settings", "error");
    }
  },

  toggleBookmark: async (path, name) => {
    const { fileBrowserConfig, saveFileBrowserConfig } = get();
    const exists = fileBrowserConfig.bookmarks.some(b => b.path === path);
    let bookmarks: FileBrowserConfig["bookmarks"];
    if (exists) {
      bookmarks = fileBrowserConfig.bookmarks.filter(b => b.path !== path);
    } else {
      const segments = path.split("/").filter(Boolean);
      const label = name ?? (segments[segments.length - 1] ?? path);
      bookmarks = [...fileBrowserConfig.bookmarks, { name: label, path }];
    }
    await saveFileBrowserConfig({ bookmarks });
  },

  updateLastPath: debounce((path: string) => {
    const { fileBrowserConfig, saveFileBrowserConfig } = get();
    if (fileBrowserConfig.persistLastPath) {
      void saveFileBrowserConfig({ lastPath: path });
    }
  }, 500),

  // ── Samba ─────────────────────────────────────────────────────────────────

  addShare: async () => {
    const { newShare, currentPath, loadShares } = get();
    if (!newShare.name.trim() || !newShare.path.trim()) return;
    set({ sambaError: "" });
    try {
      const { data, error } = await api.api.samba.shares.post(newShare);
      const errMsg = (error?.value as { error?: string })?.error
        ?? (data as { error?: string } | null)?.error;
      if (errMsg) { set({ sambaError: errMsg }); return; }
      await loadShares();
      set({ addShareOpen: false, newShare: { name: "", path: currentPath, comment: "", readOnly: false, guestOk: true } });
    } catch (e) {
      set({ sambaError: e instanceof Error ? e.message : "Failed to add share" });
    }
  },

  removeShare: async () => {
    const { removeShareTarget, loadShares } = get();
    if (!removeShareTarget) return;
    set({ sambaError: "" });
    try {
      const { data, error } = await api.api.samba.shares({ name: removeShareTarget.name }).delete();
      const errMsg = (error?.value as { error?: string })?.error
        ?? (data as { error?: string } | null)?.error;
      if (errMsg) {
        set({ sambaError: errMsg });
      } else {
        await loadShares();
      }
    } catch (e) {
      set({ sambaError: e instanceof Error ? e.message : "Failed to remove share" });
    } finally {
      set({ removeShareTarget: null });
    }
  },

  takeOverShare: async (name) => {
    set({ sambaError: "" });
    try {
      const sambaShares = api.api.samba.shares as unknown as {
        "take-over": (params: { name: string }) => { post: () => Promise<{ data: unknown; error: { value: unknown } | null }> };
      };
      const { data, error } = await sambaShares["take-over"]({ name }).post();
      const errMsg = (error?.value as { error?: string })?.error
        ?? (data as { error?: string } | null)?.error;
      if (errMsg) { set({ sambaError: errMsg }); return; }
      await get().loadShares();
    } catch (e) {
      set({ sambaError: e instanceof Error ? e.message : "Failed to migrate share" });
    }
  },

  editShare: async (name, patch) => {
    set({ sambaError: "" });
    try {
      const { data, error } = await api.api.samba.shares({ name }).patch(patch);
      const errMsg = (error?.value as { error?: string })?.error
        ?? (data as { error?: string } | null)?.error;
      if (errMsg) { set({ sambaError: errMsg }); return; }
      await get().loadShares();
    } catch (e) {
      set({ sambaError: e instanceof Error ? e.message : "Failed to update share" });
    }
  },

  reloadSmbd: async () => {
    set({ reloadingSmbd: true, sambaError: "" });
    try {
      await api.api.samba.reload.post();
    } catch (e) {
      set({ sambaError: e instanceof Error ? e.message : "Reload failed" });
    }
    set({ reloadingSmbd: false });
  },

  // ── Selection ─────────────────────────────────────────────────────────────

  toggleSelect: (path) => {
    set((s) => {
      const next = new Set(s.selectedPaths);
      next.has(path) ? next.delete(path) : next.add(path);
      return { selectedPaths: next };
    });
  },

  toggleSelectAll: () => {
    set((s) => {
      // Scoped to visible entries: selecting a dotfile the user cannot see would leave
      // them holding a selection they have no way to inspect or clear.
      const visible = visibleEntries(s.entries, s.showHidden);
      const allSelected = visible.length > 0 && visible.every(e => s.selectedPaths.has(e.path));
      return { selectedPaths: allSelected ? new Set<string>() : new Set(visible.map(e => e.path)) };
    });
  },

  toggleShowHidden: () => {
    set((s) => {
      const showHidden = !s.showHidden;
      try { localStorage.setItem(SHOW_HIDDEN_KEY, showHidden ? "1" : "0"); } catch { /* storage disabled */ }
      // Drop any selected dotfile on the way out, so hiding cannot strand a selection.
      const keep = new Set(visibleEntries(s.entries, showHidden).map(e => e.path));
      return {
        showHidden,
        selectedPaths: new Set([...s.selectedPaths].filter(p => keep.has(p))),
      };
    });
  },

  // ── Setters ───────────────────────────────────────────────────────────────

  setAddressValue:      (addressValue) => set({ addressValue }),
  setNavError:          (navError)     => set({ navError }),
  setDrawerEntry:       (drawerEntry)  => set({ drawerEntry }),
  setFileContent:       (fileContent)  => set({ fileContent }),
  setSaveMsg:           (saveMsg)      => set({ saveMsg }),
  setRenamingPath:      (renamingPath) => set({ renamingPath }),
  setRenameValue:       (renameValue)  => set({ renameValue }),
  setDeleteTarget:      (e) => set({ deleteTargets: e ? [e] : [] }),
  setDeleteTargets:     (deleteTargets) => set({ deleteTargets }),
  setCreatingFolder:    (creatingFolder) => set({ creatingFolder }),
  setNewFolderName:     (newFolderName)  => set({ newFolderName }),
  setViewMode:          (viewMode)     => set({ viewMode }),
  setCtxMenu:           (ctxMenu)      => set({ ctxMenu }),
  setUploadItems:       (uploadItems)  => set({ uploadItems }),
  setChmodTarget:       (chmodTarget)  => set({ chmodTarget }),
  setChmodValue:        (chmodValue)   => set({ chmodValue }),
  setInfoTarget:        (infoTarget)   => set({ infoTarget }),
  setArchiveDialog:     (archiveDialog) => set({ archiveDialog }),
  setArchiveName:       (archiveName)   => set({ archiveName }),
  setArchivePaths:      (archivePaths)  => set({ archivePaths }),
  setSambaOpen:         (sambaOpen)    => set({ sambaOpen }),
  setRemoveShareTarget: (removeShareTarget) => set({ removeShareTarget }),
  setAddShareOpen:      (addShareOpen) => set({ addShareOpen }),
  setNewShare:          (newShare)     => set({ newShare }),
  setSambaError:        (sambaError)   => set({ sambaError }),
  setPendingPath:       (path)         => set({ pendingNavigatePath: path }),
}));

export type { FileState };
