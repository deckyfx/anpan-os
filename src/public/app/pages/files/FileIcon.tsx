import type { FileEntry } from "./types";
import { CODE_BADGES } from "./constants";
import { emojiForEntry } from "./helpers";

interface Props {
  entry: FileEntry;
  size?: "sm" | "lg";
}

export function FileIcon({ entry, size = "sm" }: Props) {
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
  return (
    <span className={`${size === "lg" ? "text-3xl" : "text-base"} leading-none`}>
      {emojiForEntry(entry)}
    </span>
  );
}
