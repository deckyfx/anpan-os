import { useEffect, useRef } from "react";
import Plyr   from "plyr";
import Viewer from "viewerjs";
import type { FileEntry } from "./types";
import { IMAGE_EXTS, VIDEO_EXTS, AUDIO_EXTS } from "./constants";
import { formatSize } from "./helpers";
import { MonacoPreview } from "./MonacoPreview";

export { monacoLang } from "./MonacoPreview";

// ─── Media viewers ────────────────────────────────────────────────────────────

function ImageViewer({ src, name }: { src: string; name: string }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const viewer = new Viewer(el, {
      inline: true,
      navbar: false,
      title:  false,
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
      <img src={src} alt={name} className="hidden" />
    </div>
  );
}

const PLYR_CONTROLS = {
  video: ["play", "progress", "current-time", "mute", "volume", "fullscreen"],
  audio: ["play", "progress", "current-time", "mute", "volume"],
} as const;

/**
 * Media preview, styled by Plyr.
 *
 * Seeking was broken here for a while, which looked like a player fault but was not: the
 * download route did not advertise Accept-Ranges, so the browser treated the file as
 * non-seekable and refused to scrub in any player, Plyr or native. That is fixed in
 * routeFiles; Plyr was never implicated.
 */
function MediaPlayer({ src, kind }: { src: string; kind: "audio" | "video" }) {
  const ref = useRef<HTMLVideoElement & HTMLAudioElement>(null);

  useEffect(() => {
    if (!ref.current) return;
    const player = new Plyr(ref.current, { controls: [...PLYR_CONTROLS[kind]] });
    return () => { player.destroy(); };
  }, [src, kind]);

  // preload="metadata" so a duration — and therefore a usable seek bar — exists before
  // the first play rather than only once playback has started.
  return kind === "video"
    ? <video ref={ref} src={src} preload="metadata" className="w-full rounded" />
    : <audio ref={ref} src={src} preload="metadata" className="w-full" />;
}

// ─── FilePreview ──────────────────────────────────────────────────────────────

export interface FilePreviewProps {
  entry:           FileEntry;
  content:         string;
  binary:          boolean;
  onContentChange: (v: string) => void;
  onSave:          () => void;
  saving:          boolean;
  saveMsg:         string;
}

export function FilePreview({ entry, content, binary, onContentChange, onSave, saving, saveMsg }: FilePreviewProps) {
  const downloadUrl = `/api/files/download?path=${encodeURIComponent(entry.path)}`;
  // Previewing is not downloading: inline lets the browser render the bytes in place.
  const inlineUrl   = `${downloadUrl}&inline=1`;

  if (IMAGE_EXTS.has(entry.ext)) return <ImageViewer src={inlineUrl} name={entry.name} />;
  if (VIDEO_EXTS.has(entry.ext)) return <MediaPlayer src={inlineUrl} kind="video" />;
  if (AUDIO_EXTS.has(entry.ext)) return <MediaPlayer src={inlineUrl} kind="audio" />;

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
