import { useState, useEffect } from "react";
import { Globe, MoreVertical, StickyNote, Pencil, Trash2, ExternalLink } from "lucide-react";
import type { Bookmark, BookmarkAction } from "./types";

// ─── Favicon img ─────────────────────────────────────────────────────────────

function FaviconImg({ src, title }: { src: string | null; title: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [src]);

  if (!src || failed) {
    return <Globe size={32} className="text-gray-600" />;
  }
  return (
    <img
      src={src}
      alt={title}
      className="w-full h-full object-contain p-1"
      onError={() => setFailed(true)}
    />
  );
}

// ─── Context menu ─────────────────────────────────────────────────────────────

function TileMenu({ bookmark, onAction, onClose }: {
  bookmark: Bookmark;
  onAction: (action: BookmarkAction) => void;
  onClose: () => void;
}) {
  const act = (a: BookmarkAction) => { onAction(a); onClose(); };
  const item = "w-full flex items-center gap-2.5 px-3 py-1.5 rounded-lg hover:bg-gray-700 text-gray-200 transition-colors";

  return (
    <>
      <div className="fixed inset-0 z-10" onClick={onClose} />
      <div className="absolute top-8 right-0 z-20 w-44 bg-gray-800 border border-gray-700 rounded-xl shadow-2xl p-1 text-sm">
        <button className={item} onClick={() => act("edit")}>
          <Pencil size={14} className="text-amber-400 shrink-0" /> Edit
        </button>
        <button className={item} onClick={() => act("note")}>
          <StickyNote size={14} className={bookmark.note ? "text-amber-400 shrink-0" : "text-gray-400 shrink-0"} />
          Note
          {bookmark.note && <span className="ml-auto w-1.5 h-1.5 rounded-full bg-amber-400" />}
        </button>
        <div className="border-t border-gray-700 my-1 mx-1" />
        <button
          className="w-full flex items-center gap-2.5 px-3 py-1.5 rounded-lg hover:bg-red-900/40 text-red-400 transition-colors"
          onClick={() => act("delete")}
        >
          <Trash2 size={14} className="shrink-0" /> Delete…
        </button>
      </div>
    </>
  );
}

// ─── Tile ─────────────────────────────────────────────────────────────────────

export interface BookmarkTileProps {
  bookmark: Bookmark;
  onAction: (action: BookmarkAction) => void;
}

export function BookmarkTile({ bookmark, onAction }: BookmarkTileProps) {
  const [menuOpen, setMenuOpen] = useState(false);

  // Resolve icon: explicit icon URL → origin favicon → Globe fallback
  let iconSrc: string | null = bookmark.icon ?? null;
  if (!iconSrc) {
    try { iconSrc = `${new URL(bookmark.url).origin}/favicon.ico`; } catch { /* ignore */ }
  }

  // Display just the hostname as a subtitle
  let host = bookmark.url;
  try { host = new URL(bookmark.url).host; } catch { /* keep raw url */ }

  return (
    <div className="relative group">
      <div
        onClick={() => window.open(bookmark.url, "_blank", "noopener")}
        className="bg-gray-900 border border-gray-800 rounded-2xl p-5 flex flex-col items-center gap-3 cursor-pointer hover:border-gray-600 hover:bg-gray-800/60 hover:scale-[1.02] transition-all select-none"
      >
        <div className="w-16 h-16 rounded-2xl bg-gray-800 border border-gray-700 flex items-center justify-center overflow-hidden">
          <FaviconImg src={iconSrc} title={bookmark.title} />
        </div>

        <div className="w-full text-center space-y-1">
          <p className="text-sm text-gray-100 font-medium truncate">{bookmark.title}</p>
          <p className="text-[10px] text-gray-500 truncate">{host}</p>
          <a
            href={bookmark.url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={e => e.stopPropagation()}
            className="inline-flex items-center gap-1 text-[10px] text-sky-400 hover:text-sky-300 hover:underline"
          >
            <ExternalLink size={10} /> Open
          </a>
          {bookmark.note && (
            <span className="inline-block text-[9px] px-1.5 py-0.5 rounded-full bg-amber-500/10 text-amber-400 leading-none">
              has note
            </span>
          )}
        </div>
      </div>

      <button
        className="absolute top-2 right-2 text-gray-600 hover:text-gray-200 opacity-0 group-hover:opacity-100 transition-opacity w-6 h-6 flex items-center justify-center rounded-lg hover:bg-gray-700"
        onClick={e => { e.stopPropagation(); setMenuOpen(v => !v); }}
        aria-label="More options"
      >
        <MoreVertical size={14} />
      </button>

      {menuOpen && (
        <TileMenu
          bookmark={bookmark}
          onAction={onAction}
          onClose={() => setMenuOpen(false)}
        />
      )}
    </div>
  );
}
