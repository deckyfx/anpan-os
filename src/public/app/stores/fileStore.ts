import { create } from "zustand";
import { api } from "../lib/api";
import type { FileEntry, ViewMode, UploadItem, CtxMenu, SambaShare } from "../pages/files/types";
import { normalizePath, parentPath } from "../pages/files/helpers";

interface NavHistory {
  stack: string[];
  idx:   number;
}

interface NewShare {
  name:     string;
  path:     string;
  comment:  string;
  readOnly: boolean;
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
  deleteTarget: FileEntry | null;

  // ── New folder ────────────────────────────────────────────────────────────
  creatingFolder: boolean;
  newFolderName:  string;

  // ── View / selection ──────────────────────────────────────────────────────
  viewMode:      ViewMode;
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

  // ── Init ──────────────────────────────────────────────────────────────────
  initialized: boolean;

  // ── Actions ───────────────────────────────────────────────────────────────
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
  commitNewFolder:  () => Promise<void>;
  handleUpload:     (files: FileList | null) => void;
  handleChmod:      () => Promise<void>;
  handleArchive:    () => Promise<void>;
  handleExtract:    (entry: FileEntry) => Promise<void>;

  // Samba
  loadShares:       () => Promise<void>;
  checkSambaSetup:  () => Promise<void>;
  doSambaSetup:     () => Promise<void>;
  doSambaUnpatch:   () => Promise<void>;
  doSambaRebuild:   () => Promise<void>;
  addShare:         () => Promise<void>;
  removeShare:      () => Promise<void>;
  reloadSmbd:       () => Promise<void>;

  // Selection
  toggleSelect:    (path: string) => void;
  toggleSelectAll: () => void;

  // Setters
  setAddressValue:      (v: string) => void;
  setNavError:          (v: string) => void;
  setDrawerEntry:       (e: FileEntry | null) => void;
  setFileContent:       (v: string) => void;
  setSaveMsg:           (v: string) => void;
  setRenamingPath:      (v: string | null) => void;
  setRenameValue:       (v: string) => void;
  setDeleteTarget:      (e: FileEntry | null) => void;
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

  deleteTarget: null,

  creatingFolder: false,
  newFolderName:  "",

  viewMode:      "list",
  selectedPaths: new Set<string>(),

  ctxMenu: null,

  uploadItems: [],

  chmodTarget: null,
  chmodValue:  "",

  infoTarget: null,

  archiveDialog: false,
  archiveName:   "",
  archivePaths:  [],

  shares:             [],
  sambaOpen:          false,
  removeShareTarget:  null,
  addShareOpen:       false,
  newShare:           { name: "", path: "/", comment: "", readOnly: false },
  reloadingSmbd:      false,
  sambaSetupPresent:  null,
  sambaError:         "",

  initialized: false,

  // ── Init ─────────────────────────────────────────────────────────────────

  initialize: () => {
    if (get().initialized) return;
    set({ initialized: true });

    api.api.files.home.get()
      .then(({ data }) => {
        const path = (data as { path: string })?.path ?? "/";
        set({ homePath: path });
        return get().navigateTo(path);
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
    const { deleteTarget, currentPath, loadDirContent } = get();
    if (!deleteTarget) return;
    try {
      await api.api.files.delete.delete({ path: deleteTarget.path });
      await loadDirContent(currentPath);
    } catch { /* ignore */ }
    set({ deleteTarget: null });
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
      set({ addShareOpen: false, newShare: { name: "", path: currentPath, comment: "", readOnly: false } });
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
      const allSelected = s.entries.length > 0 && s.entries.every(e => s.selectedPaths.has(e.path));
      return { selectedPaths: allSelected ? new Set<string>() : new Set(s.entries.map(e => e.path)) };
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
  setDeleteTarget:      (deleteTarget) => set({ deleteTarget }),
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
}));
