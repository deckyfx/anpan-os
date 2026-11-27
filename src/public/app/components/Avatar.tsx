import { useState } from "react";
import { User } from "lucide-react";

/**
 * The user's avatar: their uploaded image, or a circle with the first letter of their name.
 *
 * Falls back to the letter when the image fails to load (removed on another device, a
 * network error). The failure is remembered per URL, so a new upload, which comes with a
 * new versioned URL, is tried again.
 *
 * @param url      - Versioned avatar URL, or null when none is set
 * @param username - Used for the letter; an empty name shows a generic person icon
 * @param size     - Diameter in pixels
 * @param alt      - Alt text for the image. Pass "" where a neighbouring label already names the user.
 */
export function Avatar({ url, username, size, alt }: {
  url: string | null;
  username: string;
  size: number;
  alt: string;
}) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const letter = username.trim().charAt(0).toUpperCase();
  // Width only, with a square aspect ratio, so `max-inline-size: 100%` can shrink it in a
  // narrow container without distorting it.
  const box = { width: size };

  if (url && failedUrl !== url) {
    return (
      <img
        src={url}
        alt={alt}
        width={size}
        height={size}
        style={box}
        onError={() => setFailedUrl(url)}
        className="rounded-full object-cover bg-gray-800 shrink-0 aspect-square h-auto max-w-full"
      />
    );
  }

  return (
    <span
      style={{ ...box, fontSize: Math.round(size * 0.45) }}
      className="rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/30 font-semibold flex items-center justify-center shrink-0 select-none leading-none aspect-square max-w-full"
      role={alt ? "img" : undefined}
      aria-label={alt || undefined}
      aria-hidden={alt ? undefined : true}
    >
      {letter || <User size={Math.round(size * 0.55)} />}
    </span>
  );
}
