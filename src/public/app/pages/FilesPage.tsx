import { useCallback, useEffect, useRef, useState } from "react";
import MonacoEditor, { type OnMount }               from "@monaco-editor/react";
import Plyr                                         from "plyr";
import Viewer                                       from "viewerjs";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Dialog }        from "../components/Dialog";

// ─── Types ────────────────────────────────────────────────────────────────────

interface FileEntry {
  name:     string;
  path:     string;
  isDir:    boolean;
  size:     number;
  modified: number;
  ext:      string;
}

interface SambaShare {
  name:       string;
  path:       string;
  comment:    string;
  readOnly:   boolean;
  browseable: boolean;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const IMAGE_EXTS = new Set(["jpg","jpeg","png","gif","webp","svg","ico","bmp","tiff","avif"]);
const VIDEO_EXTS = new Set(["mp4","webm","mkv","mov","avi","flv","wmv"]);
const AUDIO_EXTS = new Set(["mp3","wav","ogg","flac","aac","m4a","opus"]);
const ARCHIVE_EXTS = new Set(["zip","tar","gz","bz2","xz","rar","7z","tgz","zst"]);


// ── Code badge colors (VS Code–inspired) ─────────────────────────────────────

interface BadgeStyle { bg: string; fg: string; label: string }

const CODE_BADGES: Record<string, BadgeStyle> = {
  ts:   { bg: "#3178c6", fg: "#fff",  label: "TS"   },
  tsx:  { bg: "#3178c6", fg: "#fff",  label: "TSX"  },
  mts:  { bg: "#3178c6", fg: "#fff",  label: "MTS"  },
  cts:  { bg: "#3178c6", fg: "#fff",  label: "CTS"  },
  js:   { bg: "#f7df1e", fg: "#000",  label: "JS"   },
  jsx:  { bg: "#f7df1e", fg: "#000",  label: "JSX"  },
  mjs:  { bg: "#f7df1e", fg: "#000",  label: "MJS"  },
  rs:   { bg: "#ce422b", fg: "#fff",  label: "RS"   },
  go:   { bg: "#00acd7", fg: "#fff",  label: "GO"   },
  py:   { bg: "#3572a5", fg: "#fff",  label: "PY"   },
  rb:   { bg: "#cc342d", fg: "#fff",  label: "RB"   },
  java: { bg: "#b07219", fg: "#fff",  label: "JV"   },
  kt:   { bg: "#a97bff", fg: "#fff",  label: "KT"   },
  cs:   { bg: "#178600", fg: "#fff",  label: "C#"   },
  cpp:  { bg: "#f34b7d", fg: "#fff",  label: "C++"  },
  c:    { bg: "#555599", fg: "#fff",  label: "C"    },
  php:  { bg: "#4f5d95", fg: "#fff",  label: "PHP"  },
  swift:{ bg: "#fa7343", fg: "#fff",  label: "SW"   },
  dart: { bg: "#00b4ab", fg: "#fff",  label: "DT"   },
  vue:  { bg: "#41b883", fg: "#fff",  label: "VUE"  },
  svelte:{ bg:"#ff3e00", fg: "#fff",  label: "SV"   },
  scala:{ bg: "#c22d40", fg: "#fff",  label: "SC"   },
  hs:   { bg: "#5e5086", fg: "#fff",  label: "HS"   },
  lua:  { bg: "#000080", fg: "#fff",  label: "LUA"  },
  r:    { bg: "#198ce7", fg: "#fff",  label: "R"    },
  zig:  { bg: "#ec915c", fg: "#fff",  label: "ZIG"  },
  sh:   { bg: "#4eaa25", fg: "#fff",  label: "SH"   },
  bash: { bg: "#4eaa25", fg: "#fff",  label: "SH"   },
  zsh:  { bg: "#4eaa25", fg: "#fff",  label: "SH"   },
  fish: { bg: "#4eaa25", fg: "#fff",  label: "SH"   },
  sql:  { bg: "#e38c00", fg: "#fff",  label: "SQL"  },
  graphql:{ bg:"#e10098",fg: "#fff",  label: "GQL"  },
  gql:  { bg: "#e10098", fg: "#fff",  label: "GQL"  },
  prisma:{ bg:"#0c344b", fg: "#fff",  label: "PR"   },
  html: { bg: "#e44d26", fg: "#fff",  label: "HTM"  },
  css:  { bg: "#264de4", fg: "#fff",  label: "CSS"  },
  scss: { bg: "#cc6699", fg: "#fff",  label: "SCSS" },
  json: { bg: "#40474f", fg: "#fff",  label: "JSON" },
  yaml: { bg: "#cb171e", fg: "#fff",  label: "YAML" },
  yml:  { bg: "#cb171e", fg: "#fff",  label: "YAML" },
  toml: { bg: "#9c4221", fg: "#fff",  label: "TOML" },
  md:   { bg: "#083fa1", fg: "#fff",  label: "MD"   },
  mdx:  { bg: "#083fa1", fg: "#fff",  label: "MDX"  },
};

// ── Emoji fallback by category ────────────────────────────────────────────────

function emojiForEntry(entry: FileEntry): string {
  if (entry.isDir) return "📁";
  if (IMAGE_EXTS.has(entry.ext))   return "🖼️";
  if (VIDEO_EXTS.has(entry.ext))   return "🎬";
  if (AUDIO_EXTS.has(entry.ext))   return "🎵";
  if (ARCHIVE_EXTS.has(entry.ext)) return "📦";
  const ext = entry.ext;
  if (["pdf"].includes(ext))                     return "📕";
  if (["doc","docx"].includes(ext))              return "📘";
  if (["xls","xlsx","csv","tsv"].includes(ext))  return "📊";
  if (["ppt","pptx"].includes(ext))              return "📙";
  if (["iso","img","dmg"].includes(ext))         return "💿";
  if (["exe","msi","deb","rpm","apk"].includes(ext)) return "⚙️";
  if (["key","pem","crt","cer"].includes(ext))   return "🔑";
  return "📄";
}

// ── FileIcon component ────────────────────────────────────────────────────────

function FileIcon({ entry }: { entry: FileEntry }) {
  const badge = CODE_BADGES[entry.ext];
  if (badge) {
    return (
      <span
        style={{ background: badge.bg, color: badge.fg, width: 28, height: 20, fontSize: 8, borderRadius: 3 }}
        className="inline-flex items-center justify-center font-bold leading-none shrink-0"
      >
        {badge.label}
      </span>
    );
  }
  return <span className="text-base leading-none">{emojiForEntry(entry)}</span>;
}

function formatSize(bytes: number): string {
  if (bytes === 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Collapse duplicate slashes and strip trailing slash, always keep leading /. */
function normalizePath(p: string): string {
  const normalized = p.replace(/\/+/g, "/").replace(/\/$/, "");
  return normalized || "/";
}

/** Return the parent directory of a path, or "/" if already at root. */
function parentPath(p: string): string {
  const clean = normalizePath(p);
  if (clean === "/") return "/";
  const idx = clean.lastIndexOf("/");
  return idx <= 0 ? "/" : clean.slice(0, idx);
}

// ─── Component ───────────────────────────────────────────────────────────────

export function FilesPage({ onNavigate }: { onNavigate: (path: string) => void }) {
  // ── File browser state ────────────────────────────────────────────────────
  const [currentPath, setCurrentPath]   = useState<string>("/");
  const [addressValue, setAddressValue] = useState<string>("/");
  const [entries, setEntries]           = useState<FileEntry[]>([]);
  const [loadingDir, setLoadingDir]     = useState(false);
  const [navError, setNavError]         = useState("");

  // ── Navigation history ────────────────────────────────────────────────────
  const [navHistory, setNavHistory] = useState<{ stack: string[]; idx: number }>({ stack: [], idx: -1 });
  const canBack    = navHistory.idx > 0;
  const canForward = navHistory.idx < navHistory.stack.length - 1;

  // ── Home path (captured on mount) ────────────────────────────────────────
  const [homePath, setHomePath] = useState<string>("/");

  // ── Selected file / preview dialog ───────────────────────────────────────
  const [drawerEntry, setDrawerEntry]   = useState<FileEntry | null>(null);
  const [fileContent, setFileContent]   = useState("");
  const [fileBinary, setFileBinary]     = useState(false);
  const [saving, setSaving]             = useState(false);
  const [saveMsg, setSaveMsg]           = useState("");

  // ── Rename ────────────────────────────────────────────────────────────────
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renameValue, setRenameValue]   = useState("");

  // ── Delete confirm ────────────────────────────────────────────────────────
  const [deleteTarget, setDeleteTarget] = useState<FileEntry | null>(null);

  // ── New folder ────────────────────────────────────────────────────────────
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName]   = useState("");

  // ── Upload ────────────────────────────────────────────────────────────────
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading]       = useState(false);

  // ── Samba ─────────────────────────────────────────────────────────────────
  const [shares, setShares]             = useState<SambaShare[]>([]);
  const [sambaOpen, setSambaOpen]       = useState(false);
  const [removeShareTarget, setRemoveShareTarget] = useState<SambaShare | null>(null);
  const [addShareOpen, setAddShareOpen] = useState(false);
  const [newShare, setNewShare]         = useState({ name: "", path: "/", comment: "", readOnly: false });
  const [reloadingSmbd, setReloadingSmbd] = useState(false);

  // ── Load directory content (pure fetch, no history side-effects) ──────────

  const loadDirContent = useCallback(async (path: string): Promise<boolean> => {
    const trimmed = normalizePath(path.trim());
    if (!trimmed) return false;
    setLoadingDir(true);
    try {
      const res = await fetch(`/api/files/list?path=${encodeURIComponent(trimmed)}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        setNavError(body.error ?? `Cannot open "${trimmed}" (${res.status})`);
        return false;
      }
      const data = await res.json() as FileEntry[];
      data.sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      setEntries(data);
      setCurrentPath(trimmed);
      setAddressValue(trimmed);
      return true;
    } catch (e) {
      setNavError(String(e));
      return false;
    } finally {
      setLoadingDir(false);
    }
  }, []);

  // ── Navigate to a new path — pushes history, slices forward stack ─────────

  const navigateTo = useCallback(async (path: string) => {
    const trimmed = normalizePath(path.trim());
    const ok = await loadDirContent(trimmed);
    if (!ok) return;
    setNavHistory((prev) => {
      // Don't push a duplicate of the current entry
      if (prev.stack[prev.idx] === trimmed) return prev;
      const stack = [...prev.stack.slice(0, prev.idx + 1), trimmed];
      return { stack, idx: stack.length - 1 };
    });
  }, [loadDirContent]);

  // ── Back / Forward ────────────────────────────────────────────────────────

  const goBack = useCallback(async () => {
    setNavHistory((prev) => {
      if (prev.idx <= 0) return prev;
      const newIdx = prev.idx - 1;
      const target = prev.stack[newIdx];
      if (target !== undefined) void loadDirContent(target);
      return { ...prev, idx: newIdx };
    });
  }, [loadDirContent]);

  const goForward = useCallback(async () => {
    setNavHistory((prev) => {
      if (prev.idx >= prev.stack.length - 1) return prev;
      const newIdx = prev.idx + 1;
      const target = prev.stack[newIdx];
      if (target !== undefined) void loadDirContent(target);
      return { ...prev, idx: newIdx };
    });
  }, [loadDirContent]);

  // On mount: fetch home dir, save it, and navigate there
  useEffect(() => {
    fetch("/api/files/home")
      .then((r) => r.json() as Promise<{ path: string }>)
      .then(({ path }) => { setHomePath(path); return navigateTo(path); })
      .catch(() => navigateTo("/"));
  }, []);

  // ── Load samba shares ─────────────────────────────────────────────────────

  const loadShares = useCallback(async () => {
    try {
      const res = await fetch("/api/samba/shares");
      if (res.ok) setShares(await res.json() as SambaShare[]);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { loadShares(); }, []);

  // ── Open file ─────────────────────────────────────────────────────────────

  async function openFile(entry: FileEntry) {
    setDrawerEntry(entry);
    setFileContent("");
    setFileBinary(false);
    setSaveMsg("");
    // Always ask the server — it detects binary via byte inspection
    try {
      const res = await fetch(`/api/files/read?path=${encodeURIComponent(entry.path)}`);
      if (res.ok) {
        const data = await res.json() as { content: string; binary: boolean };
        setFileBinary(data.binary);
        setFileContent(data.binary ? "" : data.content);
      }
    } catch { /* show download-only view */ }
  }

  async function saveFile() {
    if (!drawerEntry) return;
    setSaving(true);
    setSaveMsg("");
    try {
      const res = await fetch("/api/files/write", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: drawerEntry.path, content: fileContent }),
      });
      setSaveMsg(res.ok ? "Saved" : "Error saving");
    } catch {
      setSaveMsg("Error saving");
    } finally {
      setSaving(false);
    }
  }

  // ── Rename ────────────────────────────────────────────────────────────────

  async function commitRename(entry: FileEntry) {
    if (!renameValue.trim() || renameValue === entry.name) {
      setRenamingPath(null);
      return;
    }
    const dir = currentPath.endsWith("/") ? currentPath : currentPath + "/";
    const to  = dir + renameValue.trim();
    try {
      const res = await fetch("/api/files/rename", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from: entry.path, to }),
      });
      if (res.ok) await loadDirContent(currentPath);
    } catch { /* ignore */ }
    setRenamingPath(null);
  }

  // ── Delete ────────────────────────────────────────────────────────────────

  async function confirmDelete() {
    if (!deleteTarget) return;
    try {
      await fetch("/api/files/delete", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: deleteTarget.path }),
      });
      await loadDirContent(currentPath);
    } catch { /* ignore */ }
    setDeleteTarget(null);
  }

  // ── New folder ────────────────────────────────────────────────────────────

  async function commitNewFolder() {
    if (!newFolderName.trim()) { setCreatingFolder(false); return; }
    const dir = currentPath.endsWith("/") ? currentPath : currentPath + "/";
    try {
      const res = await fetch("/api/files/mkdir", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: dir + newFolderName.trim() }),
      });
      if (res.ok) await loadDirContent(currentPath);
    } catch { /* ignore */ }
    setCreatingFolder(false);
    setNewFolderName("");
  }

  // ── Upload ────────────────────────────────────────────────────────────────

  async function handleUpload(files: FileList | null) {
    if (!files?.length) return;
    setUploading(true);
    try {
      for (const file of Array.from(files)) {
        const fd = new FormData();
        fd.append("file", file);
        await fetch(`/api/files/upload?path=${encodeURIComponent(currentPath)}`, {
          method: "POST",
          body: fd,
        });
      }
      await loadDirContent(currentPath);
    } finally {
      setUploading(false);
    }
  }

  // ── Samba ─────────────────────────────────────────────────────────────────

  async function addShare() {
    if (!newShare.name.trim() || !newShare.path.trim()) return;
    try {
      const res = await fetch("/api/samba/shares", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(newShare),
      });
      if (res.ok) {
        await loadShares();
        setAddShareOpen(false);
        setNewShare({ name: "", path: currentPath, comment: "", readOnly: false });
      }
    } catch { /* ignore */ }
  }

  async function removeShare() {
    if (!removeShareTarget) return;
    try {
      const res = await fetch(`/api/samba/shares/${encodeURIComponent(removeShareTarget.name)}`, {
        method: "DELETE",
      });
      if (res.ok) await loadShares();
    } catch { /* ignore */ }
    setRemoveShareTarget(null);
  }

  async function reloadSmbd() {
    setReloadingSmbd(true);
    try {
      await fetch("/api/samba/reload", { method: "POST" });
    } catch { /* ignore */ }
    setReloadingSmbd(false);
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-gray-950 text-white flex flex-col">

      {/* Top bar */}
      <header className="border-b border-gray-800 px-5 py-3 flex items-center gap-3">
        <button
          onClick={() => onNavigate("/")}
          className="text-gray-400 hover:text-white transition-colors text-sm"
        >
          ← Home
        </button>
        <span className="text-gray-700">|</span>
        <span className="text-sm font-medium text-gray-300">File Manager</span>
      </header>

      {/* Address bar + actions */}
      <div className="px-5 py-3 flex items-center gap-2 border-b border-gray-900">
        {/* Back */}
        <button
          onClick={goBack}
          disabled={!canBack || loadingDir}
          title="Back"
          className="p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-gray-800 transition-colors disabled:opacity-30 disabled:cursor-not-allowed shrink-0"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M10 3L5 8l5 5" />
          </svg>
        </button>

        {/* Forward */}
        <button
          onClick={goForward}
          disabled={!canForward || loadingDir}
          title="Forward"
          className="p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-gray-800 transition-colors disabled:opacity-30 disabled:cursor-not-allowed shrink-0"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M6 3l5 5-5 5" />
          </svg>
        </button>

        {/* Up one folder */}
        <button
          onClick={() => navigateTo(parentPath(currentPath))}
          disabled={currentPath === "/" || loadingDir}
          title="Up one folder"
          className="p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-gray-800 transition-colors disabled:opacity-30 disabled:cursor-not-allowed shrink-0"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M2 13h12M2 6.5h3.5V13M8 3.5L5.5 6M8 3.5L10.5 6M8 3.5V10" />
          </svg>
        </button>

        {/* Home */}
        <button
          onClick={() => navigateTo(homePath)}
          disabled={loadingDir}
          title="Home directory"
          className="p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-gray-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M2 7.5L8 2l6 5.5" />
            <path d="M4 7v6h3v-3h2v3h3V7" />
          </svg>
        </button>

        {/* Editable path input */}
        <input
          value={addressValue}
          onChange={(e) => setAddressValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") navigateTo(addressValue); }}
          spellCheck={false}
          className="flex-1 bg-gray-900 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-gray-200 font-mono outline-none focus:border-blue-500 transition-colors"
          placeholder="/path/to/directory"
        />
        <button
          onClick={() => navigateTo(addressValue)}
          disabled={loadingDir}
          className="px-3 py-1.5 rounded-lg text-xs font-medium bg-blue-600 hover:bg-blue-700 text-white transition-colors disabled:opacity-50 shrink-0"
        >
          Go
        </button>

        <span className="text-gray-800">|</span>

        {/* Upload */}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => handleUpload(e.target.files)}
        />
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
          className="px-3 py-1.5 rounded-lg text-xs font-medium bg-gray-800 hover:bg-gray-700 text-gray-300 hover:text-white transition-colors disabled:opacity-50 shrink-0"
        >
          {uploading ? "Uploading…" : "↑ Upload"}
        </button>

        {/* New folder */}
        <button
          onClick={() => { setCreatingFolder(true); setNewFolderName(""); }}
          className="px-3 py-1.5 rounded-lg text-xs font-medium bg-gray-800 hover:bg-gray-700 text-gray-300 hover:text-white transition-colors shrink-0"
        >
          + Folder
        </button>
      </div>

      {/* File listing */}
      <div className="flex-1 px-5 py-4 overflow-auto">
        {loadingDir ? (
          <p className="text-gray-500 text-sm">Loading…</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-gray-600 text-xs uppercase tracking-wide">
                <th className="pb-2 pr-4 font-medium">Name</th>
                <th className="pb-2 pr-4 font-medium w-16">Type</th>
                <th className="pb-2 pr-4 font-medium w-20 text-right">Size</th>
                <th className="pb-2 pr-4 font-medium w-20 text-right">Modified</th>
                <th className="pb-2 font-medium w-16" />
              </tr>
            </thead>
            <tbody>
              {/* New folder row */}
              {creatingFolder && (
                <tr>
                  <td colSpan={5} className="py-1">
                    <input
                      autoFocus
                      value={newFolderName}
                      onChange={(e) => setNewFolderName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitNewFolder();
                        if (e.key === "Escape") setCreatingFolder(false);
                      }}
                      onBlur={commitNewFolder}
                      placeholder="Folder name…"
                      className="bg-gray-800 border border-gray-600 rounded px-2 py-1 text-sm text-white outline-none w-48"
                    />
                  </td>
                </tr>
              )}

              {entries.length === 0 && !creatingFolder && (
                <tr>
                  <td colSpan={5} className="py-6 text-center text-gray-600 text-xs">
                    Empty directory
                  </td>
                </tr>
              )}

              {entries.map((entry) => (
                <tr
                  key={entry.path}
                  className="group border-t border-gray-900 hover:bg-gray-900 transition-colors"
                >
                  {/* Name */}
                  <td className="py-2 pr-4">
                    {renamingPath === entry.path ? (
                      <input
                        autoFocus
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") commitRename(entry);
                          if (e.key === "Escape") setRenamingPath(null);
                        }}
                        onBlur={() => commitRename(entry)}
                        className="bg-gray-800 border border-gray-600 rounded px-2 py-0.5 text-sm text-white outline-none"
                      />
                    ) : (
                      <button
                        onClick={() => entry.isDir ? navigateTo(entry.path) : openFile(entry)}
                        className="flex items-center gap-2 hover:text-blue-400 transition-colors text-left"
                      >
                        <FileIcon entry={entry} />
                        <span>{entry.name}</span>
                      </button>
                    )}
                  </td>

                  {/* Type */}
                  <td className="py-2 pr-4 text-gray-500">
                    {entry.isDir ? "dir" : (entry.ext || "—")}
                  </td>

                  {/* Size */}
                  <td className="py-2 pr-4 text-gray-500 text-right">
                    {entry.isDir ? "—" : formatSize(entry.size)}
                  </td>

                  {/* Modified */}
                  <td className="py-2 pr-4 text-gray-500 text-right">
                    {formatDate(entry.modified)}
                  </td>

                  {/* Actions */}
                  <td className="py-2 text-right">
                    <span className="opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-end gap-2">
                      <button
                        onClick={() => { setRenamingPath(entry.path); setRenameValue(entry.name); }}
                        title="Rename"
                        className="text-gray-500 hover:text-white transition-colors"
                      >
                        ✏️
                      </button>
                      <button
                        onClick={() => setDeleteTarget(entry)}
                        title="Delete"
                        className="text-gray-500 hover:text-red-400 transition-colors"
                      >
                        🗑
                      </button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Samba section */}
      <div className="border-t border-gray-800 px-5 py-3">
        <button
          onClick={() => setSambaOpen((v) => !v)}
          className="flex items-center gap-2 text-sm text-gray-400 hover:text-white transition-colors w-full text-left"
        >
          <span className={`transition-transform ${sambaOpen ? "rotate-90" : ""}`}>›</span>
          <span>Samba Shares</span>
          <span className="flex-1 border-t border-gray-800 ml-2" />
          <button
            onClick={(e) => {
              e.stopPropagation();
              setNewShare((n) => ({ ...n, path: currentPath }));
              setAddShareOpen(true);
            }}
            className="text-xs px-2 py-0.5 rounded bg-gray-800 hover:bg-gray-700 text-gray-300 hover:text-white transition-colors"
          >
            +
          </button>
        </button>

        {sambaOpen && (
          <div className="mt-3 space-y-2">
            {shares.length === 0 && (
              <p className="text-gray-600 text-xs">No shares configured.</p>
            )}
            {shares.map((share) => (
              <div key={share.name} className="flex items-center justify-between gap-2 text-sm">
                <div className="flex-1 min-w-0">
                  <span className="font-medium text-gray-300">{share.name}</span>
                  <span className="text-gray-600 ml-2 truncate">{share.path}</span>
                </div>
                <button
                  onClick={() => setRemoveShareTarget(share)}
                  className="text-xs text-red-500 hover:text-red-400 transition-colors shrink-0"
                >
                  Remove
                </button>
              </div>
            ))}

            {shares.length > 0 && (
              <div className="flex justify-end pt-1">
                <button
                  onClick={reloadSmbd}
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

      {/* File preview / editor dialog */}
      <Dialog
        open={!!drawerEntry}
        title={drawerEntry?.name ?? ""}
        onClose={() => setDrawerEntry(null)}
        size="xl"
      >
        {drawerEntry && (
          <FilePreview
            entry={drawerEntry}
            content={fileContent}
            binary={fileBinary}
            onContentChange={setFileContent}
            onSave={saveFile}
            saving={saving}
            saveMsg={saveMsg}
          />
        )}
      </Dialog>

      {/* Add share dialog */}
      {addShareOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
          onClick={(e) => { if (e.target === e.currentTarget) setAddShareOpen(false); }}
        >
          <div className="w-full max-w-md bg-gray-900 border border-gray-700 rounded-xl shadow-2xl">
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
              <h2 className="text-base font-semibold text-white">Add Samba Share</h2>
              <button onClick={() => setAddShareOpen(false)} className="text-gray-400 hover:text-white transition-colors text-xl">✕</button>
            </div>
            <div className="px-5 py-4 space-y-3">
              <label className="block">
                <span className="text-xs text-gray-400 block mb-1">Share Name</span>
                <input
                  value={newShare.name}
                  onChange={(e) => setNewShare((n) => ({ ...n, name: e.target.value }))}
                  placeholder="Shared01"
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-blue-500"
                />
              </label>
              <label className="block">
                <span className="text-xs text-gray-400 block mb-1">Path</span>
                <input
                  value={newShare.path}
                  onChange={(e) => setNewShare((n) => ({ ...n, path: e.target.value }))}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-blue-500"
                />
              </label>
              <label className="block">
                <span className="text-xs text-gray-400 block mb-1">Comment (optional)</span>
                <input
                  value={newShare.comment}
                  onChange={(e) => setNewShare((n) => ({ ...n, comment: e.target.value }))}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-blue-500"
                />
              </label>
              <label className="flex items-center gap-2 text-sm text-gray-300">
                <input
                  type="checkbox"
                  checked={newShare.readOnly}
                  onChange={(e) => setNewShare((n) => ({ ...n, readOnly: e.target.checked }))}
                />
                Read only
              </label>
            </div>
            <div className="px-5 py-4 border-t border-gray-800 flex justify-end gap-2">
              <button
                onClick={() => setAddShareOpen(false)}
                className="px-4 py-2 rounded-lg text-sm text-gray-300 hover:text-white hover:bg-gray-800 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={addShare}
                className="px-4 py-2 rounded-lg text-sm font-medium bg-blue-600 hover:bg-blue-700 text-white transition-colors"
              >
                Add Share
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Navigation error dialog */}
      <Dialog
        open={!!navError}
        title="Cannot open path"
        onClose={() => setNavError("")}
        footer={
          <button
            onClick={() => setNavError("")}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-gray-700 hover:bg-gray-600 text-white transition-colors"
          >
            OK
          </button>
        }
      >
        <p className="text-sm text-gray-300 font-mono break-all">{navError}</p>
      </Dialog>

      {/* Delete confirm */}
      <ConfirmDialog
        open={!!deleteTarget}
        title="Delete"
        message={`Delete "${deleteTarget?.name}"? This cannot be undone.`}
        confirmLabel="Delete"
        danger
        onConfirm={confirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />

      {/* Remove share confirm */}
      <ConfirmDialog
        open={!!removeShareTarget}
        title="Remove Share"
        message={`Remove Samba share "${removeShareTarget?.name}"?`}
        confirmLabel="Remove"
        danger
        onConfirm={removeShare}
        onCancel={() => setRemoveShareTarget(null)}
      />
    </div>
  );
}

// ─── Monaco language detection ───────────────────────────────────────────────

function monacoLang(ext: string): string {
  const map: Record<string, string> = {
    ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
    js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
    html: "html", htm: "html", vue: "html", svelte: "html", astro: "html",
    css: "css", scss: "scss", sass: "scss", less: "less",
    json: "json", jsonl: "json",
    yaml: "yaml", yml: "yaml",
    md: "markdown", mdx: "markdown", rst: "markdown",
    rs: "rust",
    go: "go",
    py: "python",
    rb: "ruby",
    java: "java",
    c: "c", h: "c",
    cpp: "cpp", hpp: "cpp", cc: "cpp", hh: "cpp", cxx: "cpp",
    cs: "csharp",
    php: "php",
    swift: "swift",
    kt: "kotlin", kts: "kotlin",
    dart: "dart",
    sh: "shell", bash: "shell", zsh: "shell", fish: "shell", cmd: "shell",
    ps1: "powershell",
    sql: "sql",
    graphql: "graphql", gql: "graphql",
    xml: "xml", plist: "xml", proto: "xml",
    toml: "ini", ini: "ini", cfg: "ini", conf: "ini", env: "ini",
    dockerfile: "dockerfile",
    lua: "lua",
    r: "r",
    scala: "scala",
    hs: "haskell",
    pl: "perl",
    ex: "elixir", exs: "elixir",
  };
  return map[ext] ?? "plaintext";
}

// ─── Viewer sub-components ────────────────────────────────────────────────────

function ImageViewer({ src, name }: { src: string; name: string }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const viewer = new Viewer(el, {
      inline: true,
      navbar: false,
      title: false,
      toolbar: {
        zoomIn: 4, zoomOut: 4, oneToOne: 4, reset: 4,
        rotateLeft: 4, rotateRight: 4,
        flipHorizontal: 4, flipVertical: 4,
      },
    });
    viewer.show();
    return () => { viewer.destroy(); };
  }, [src]);

  return (
    <div
      ref={containerRef}
      className="relative w-full rounded overflow-hidden bg-gray-950"
      style={{ height: "65vh" }}
    >
      <img src={src} alt={name} />
    </div>
  );
}

function VideoPlayer({ src }: { src: string }) {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (!ref.current) return;
    const p = new Plyr(ref.current, { controls: ["play","progress","current-time","mute","volume","fullscreen"] });
    return () => { p.destroy(); };
  }, [src]);

  return <video ref={ref} src={src} className="w-full rounded" />;
}

function AudioPlayer({ src }: { src: string }) {
  const ref = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    if (!ref.current) return;
    const p = new Plyr(ref.current, { controls: ["play","progress","current-time","mute","volume"] });
    return () => { p.destroy(); };
  }, [src]);

  return <audio ref={ref} src={src} className="w-full" />;
}

// ─── Monaco preview with fullscreen ──────────────────────────────────────────

interface MonacoPreviewProps {
  ext:             string;
  content:         string;
  onContentChange: (v: string) => void;
  onSave:          () => void;
  saving:          boolean;
  saveMsg:         string;
}

function MonacoPreview({ ext, content, onContentChange, onSave, saving, saveMsg }: MonacoPreviewProps) {
  const [fullscreen, setFullscreen] = useState(false);
  const onSaveRef = useRef(onSave);

  useEffect(() => { onSaveRef.current = onSave; }, [onSave]);

  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setFullscreen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullscreen]);

  const lang = monacoLang(ext);

  const handleMount: OnMount = (editor, monaco) => {
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => onSaveRef.current());
  };

  const toolbar = (
    <div className="flex items-center gap-2 px-2 h-10 border-b border-gray-800 bg-gray-900">
      <span className="text-xs text-gray-500 font-mono mr-auto">{lang}</span>
      {saveMsg && (
        <span className={`text-xs ${saveMsg === "Saved" ? "text-green-400" : "text-red-400"}`}>
          {saveMsg}
        </span>
      )}
      {/* Save icon button */}
      <button
        onClick={onSave}
        disabled={saving}
        title="Save (Ctrl+S)"
        className="p-1.5 rounded text-gray-400 hover:text-white hover:bg-gray-700 transition-colors disabled:opacity-40"
      >
        {saving ? (
          <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="animate-spin">
            <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
          </svg>
        ) : (
          <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/>
            <path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7"/>
            <path d="M7 3v4a1 1 0 0 0 1 1h7"/>
          </svg>
        )}
      </button>
      {/* Fullscreen toggle icon button */}
      <button
        onClick={() => setFullscreen((f) => !f)}
        title={fullscreen ? "Exit fullscreen (Esc)" : "Fullscreen"}
        className="p-1.5 rounded text-gray-400 hover:text-white hover:bg-gray-700 transition-colors"
      >
        {fullscreen ? (
          <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M8 3v3a2 2 0 0 1-2 2H3"/><path d="M21 8h-3a2 2 0 0 1-2-2V3"/>
            <path d="M3 16h3a2 2 0 0 1 2 2v3"/><path d="M16 21v-3a2 2 0 0 1 2-2h3"/>
          </svg>
        ) : (
          <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 8V5a2 2 0 0 1 2-2h3"/><path d="M16 3h3a2 2 0 0 1 2 2v3"/>
            <path d="M21 16v3a2 2 0 0 1-2 2h-3"/><path d="M8 21H5a2 2 0 0 1-2-2v-3"/>
          </svg>
        )}
      </button>
    </div>
  );

  if (fullscreen) {
    return (
      <div className="fixed inset-0 z-200 bg-gray-950 flex flex-col">
        {toolbar}
        <div className="flex-1 overflow-hidden">
          <MonacoEditor
            height="calc(100vh - 40px)"
            language={lang}
            value={content}
            onChange={(val) => onContentChange(val ?? "")}
            theme="vs-dark"
            onMount={handleMount}
            options={{
              minimap:              { enabled: true },
              fontSize:             14,
              lineNumbers:          "on",
              scrollBeyondLastLine: false,
              wordWrap:             "on",
              automaticLayout:      true,
              padding:              { top: 8 },
            }}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col rounded overflow-hidden border border-gray-800">
      {toolbar}
      <MonacoEditor
        height="62vh"
        language={lang}
        value={content}
        onChange={(val) => onContentChange(val ?? "")}
        theme="vs-dark"
        onMount={handleMount}
        options={{
          minimap:              { enabled: false },
          fontSize:             13,
          lineNumbers:          "on",
          scrollBeyondLastLine: false,
          wordWrap:             "on",
          automaticLayout:      true,
          padding:              { top: 8 },
        }}
      />
    </div>
  );
}

// ─── File preview sub-component ───────────────────────────────────────────────

interface FilePreviewProps {
  entry:           FileEntry;
  content:         string;
  binary:          boolean;
  onContentChange: (v: string) => void;
  onSave:          () => void;
  saving:          boolean;
  saveMsg:         string;
}

function FilePreview({ entry, content, binary, onContentChange, onSave, saving, saveMsg }: FilePreviewProps) {
  const downloadUrl = `/api/files/download?path=${encodeURIComponent(entry.path)}`;

  if (IMAGE_EXTS.has(entry.ext)) {
    return <ImageViewer src={downloadUrl} name={entry.name} />;
  }

  if (VIDEO_EXTS.has(entry.ext)) {
    return <VideoPlayer src={downloadUrl} />;
  }

  if (AUDIO_EXTS.has(entry.ext)) {
    return <AudioPlayer src={downloadUrl} />;
  }

  if (!binary) {
    return (
      <MonacoPreview
        ext={entry.ext}
        content={content}
        onContentChange={onContentChange}
        onSave={onSave}
        saving={saving}
        saveMsg={saveMsg}
      />
    );
  }

  return (
    <div className="flex flex-col items-center justify-center gap-4 py-8 text-center">
      <span className="text-4xl">📦</span>
      <p className="text-gray-400 text-sm">{entry.name}</p>
      <p className="text-gray-600 text-xs">{formatSize(entry.size)}</p>
      <a
        href={downloadUrl}
        download={entry.name}
        className="px-4 py-2 rounded-lg text-sm font-medium bg-blue-600 hover:bg-blue-700 text-white transition-colors"
      >
        Download
      </a>
    </div>
  );
}
