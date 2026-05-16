import type { FileEntry } from "./types";
import { CODE_BADGES } from "./constants";
import { emojiForEntry } from "./helpers";

interface Props {
  entry: FileEntry;
  size?: "sm" | "lg";
  shared?: boolean;
}

export function FileIcon({ entry, size = "sm", shared = false }: Props) {
  const badge = CODE_BADGES[entry.ext];
  if (badge) {
    return (
      <span
        style={{
          background: badge.bg,
          color:      badge.fg,
          width:      size === "lg" ? 44 : 28,
          height:     size === "lg" ? 30 : 20,
          fontSize:   size === "lg" ? 10 : 8,
          borderRadius: 4,
        }}
        className="inline-flex items-center justify-center font-bold leading-none shrink-0"
      >
        {badge.label}
      </span>
    );
  }
  const isShared = entry.isDir && shared;
  return (
    <span className={`relative inline-flex items-center justify-center ${size === "lg" ? "text-3xl" : "text-base"} leading-none shrink-0`}>
      {emojiForEntry(entry)}
      {isShared && (
        <span className={`absolute ${size === "lg" ? "-top-1.5 -right-1.5 w-4 h-4" : "-top-1 -right-1 w-3 h-3"} bg-green-500 rounded-full flex items-center justify-center shadow-sm`}>
          <svg width={size === "lg" ? 9 : 7} height={size === "lg" ? 9 : 7} viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
        </span>
      )}
    </span>
  );
}
