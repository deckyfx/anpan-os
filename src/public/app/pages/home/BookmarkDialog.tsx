import { useState, useEffect } from "react";
import { Globe } from "lucide-react";
import { Dialog } from "../../components/Dialog";
import { api } from "../../lib/api";
import { useToastStore } from "../../stores/toastStore";
import type { Bookmark } from "./types";

interface Props {
  /** Existing bookmark to edit, or null when creating a new one. */
  bookmark: Bookmark | null;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}

export function BookmarkDialog({ bookmark, open, onClose, onSaved }: Props) {
  if (!open) return null;
  return (
    <BookmarkDialogInner
      key={bookmark?.id ?? "new"}
      bookmark={bookmark}
      onClose={onClose}
      onSaved={onSaved}
    />
  );
}

function BookmarkDialogInner({ bookmark, onClose, onSaved }: Omit<Props, "open">) {
  const isEdit = bookmark !== null;

  const [title,   setTitle]   = useState(bookmark?.title ?? "");
  const [url,     setUrl]     = useState(bookmark?.url   ?? "");
  const [icon,    setIcon]    = useState(bookmark?.icon  ?? "");
  const [busy,    setBusy]    = useState(false);
  const [error,   setError]   = useState("");

  // Auto-populate title from URL hostname when title is still empty
  useEffect(() => {
    if (title || !url) return;
    try {
      const hostname = new URL(url.startsWith("http") ? url : `https://${url}`).hostname;
      setTitle(hostname);
    } catch { /* invalid URL — leave title blank */ }
  }, [url]);

  const normaliseUrl = (raw: string): string => {
    const trimmed = raw.trim();
    if (!trimmed) return trimmed;
    if (/^https?:\/\//i.test(trimmed)) return trimmed;
    return `https://${trimmed}`;
  };

  const handleSave = async () => {
    const normUrl = normaliseUrl(url);
    if (!title.trim()) { setError("Title is required"); return; }
    if (!normUrl)       { setError("URL is required");   return; }

    // Basic URL validation
    try { new URL(normUrl); } catch {
      setError("Enter a valid URL (e.g. https://example.com)");
      return;
    }

    setBusy(true);
    setError("");
    try {
      if (isEdit) {
        const { error: err } = await api.api.bookmarks({ id: String(bookmark.id) }).patch({
          title: title.trim(),
          url:   normUrl,
          icon:  icon.trim() || undefined,
        });
        if (err) { setError((err.value as { error?: string })?.error ?? "Server error"); return; }
      } else {
        const { error: err } = await api.api.bookmarks.post({
          title: title.trim(),
          url:   normUrl,
          icon:  icon.trim() || undefined,
        });
        if (err) { setError((err.value as { error?: string })?.error ?? "Server error"); return; }
      }
      useToastStore.getState().push(isEdit ? "Bookmark updated" : "Bookmark added", "success");
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  // Derive favicon preview URL from the entered URL
  let faviconPreview: string | null = null;
  try {
    const normUrl = normaliseUrl(url);
    if (normUrl) faviconPreview = `${new URL(normUrl).origin}/favicon.ico`;
  } catch { /* ignore */ }

  const footer = (
    <>
      <button
        onClick={onClose}
        disabled={busy}
        className="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors disabled:opacity-50"
      >
        Cancel
      </button>
      <button
        onClick={() => void handleSave()}
        disabled={busy}
        className="px-4 py-2 text-sm bg-sky-600 hover:bg-sky-500 text-white font-semibold rounded-lg transition-colors disabled:opacity-50"
      >
        {busy ? "Saving…" : isEdit ? "Save" : "Add Bookmark"}
      </button>
    </>
  );

  return (
    <Dialog
      open
      title={isEdit ? "Edit Bookmark" : "Add External App"}
      onClose={onClose}
      disableBackdropClose
      size="md"
      footer={footer}
      notification={error ? (
        <p className="text-red-400 text-sm bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
          {error}
        </p>
      ) : undefined}
    >
      <div className="space-y-4">

        {/* Icon preview + field */}
        <div className="flex items-center gap-4">
          <div className="w-14 h-14 rounded-xl bg-gray-800 border border-gray-700 flex items-center justify-center shrink-0 overflow-hidden">
            <FaviconImg src={icon.trim() || faviconPreview} title={title || "?"} />
          </div>
          <div className="flex-1 space-y-1">
            <label className="block text-xs text-gray-400 font-medium">Icon URL</label>
            <input
              type="url"
              value={icon}
              onChange={e => setIcon(e.target.value)}
              placeholder="https://example.com/icon.png (optional)"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-sky-500"
            />
            <p className="text-[10px] text-gray-600">Leave blank to auto-use the site's favicon</p>
          </div>
        </div>

        {/* Title */}
        <div className="space-y-1">
          <label className="block text-xs text-gray-400 font-medium">Title <span className="text-red-400">*</span></label>
          <input
            type="text"
            value={title}
            onChange={e => setTitle(e.target.value)}
            placeholder="My App"
            autoFocus={!isEdit}
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-sky-500"
          />
        </div>

        {/* URL */}
        <div className="space-y-1">
          <label className="block text-xs text-gray-400 font-medium">URL <span className="text-red-400">*</span></label>
          <input
            type="url"
            value={url}
            onChange={e => setUrl(e.target.value)}
            placeholder="https://example.com"
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-sky-500"
          />
        </div>

      </div>
    </Dialog>
  );
}

/** Renders a favicon img with a Globe icon fallback. */
function FaviconImg({ src, title }: { src: string | null; title: string }) {
  const [failed, setFailed] = useState(false);

  useEffect(() => { setFailed(false); }, [src]);

  if (!src || failed) {
    return <Globe size={28} className="text-gray-600" />;
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
