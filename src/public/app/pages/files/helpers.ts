import type { FileEntry } from "./types";
import { IMAGE_EXTS, VIDEO_EXTS, AUDIO_EXTS, ARCHIVE_EXTS } from "./constants";

export function formatSize(bytes: number): string {
  if (bytes === 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

export function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Collapse duplicate slashes and strip trailing slash, always keep leading /. */
export function normalizePath(p: string): string {
  const normalized = p.replace(/\/+/g, "/").replace(/\/$/, "");
  return normalized || "/";
}

/** Return the parent directory of a path, or "/" if already at root. */
export function parentPath(p: string): string {
  const clean = normalizePath(p);
  if (clean === "/") return "/";
  const idx = clean.lastIndexOf("/");
  return idx <= 0 ? "/" : clean.slice(0, idx);
}

export function emojiForEntry(entry: FileEntry): string {
  if (entry.isDir) return "📁";
  if (IMAGE_EXTS.has(entry.ext))   return "🖼️";
  if (VIDEO_EXTS.has(entry.ext))   return "🎬";
  if (AUDIO_EXTS.has(entry.ext))   return "🎵";
  if (ARCHIVE_EXTS.has(entry.ext)) return "📦";
  const ext = entry.ext;
  if (["pdf"].includes(ext))                      return "📕";
  if (["doc","docx"].includes(ext))               return "📘";
  if (["xls","xlsx","csv","tsv"].includes(ext))   return "📊";
  if (["ppt","pptx"].includes(ext))               return "📙";
  if (["iso","img","dmg"].includes(ext))          return "💿";
  if (["exe","msi","deb","rpm","apk"].includes(ext)) return "⚙️";
  if (["key","pem","crt","cer"].includes(ext))    return "🔑";
  return "📄";
}
