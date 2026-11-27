import { useEffect, useRef, useState } from "react";
import { Loader2, Upload, Trash2, ImageUp } from "lucide-react";
import { InlineConfirm } from "./InlineConfirm";
import { PRIMARY_BUTTON, QUIET_BUTTON } from "./styles";
import { Avatar } from "../../components/Avatar";
import { api } from "../../lib/api";
import { useAuthStore } from "../../stores/authStore";
import { useToastStore } from "../../stores/toastStore";

/** Types the server accepts; the picker offers only these. */
const ACCEPTED_TYPES = ["image/png", "image/jpeg", "image/webp"];
/** Edge of the square that is uploaded. */
const AVATAR_SIZE = 256;

/** Decode an image file into an element that can be drawn on a canvas. */
function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload  = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("That file could not be read as an image")); };
    img.src = url;
  });
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise(resolve => canvas.toBlob(resolve, type, quality));
}

/**
 * Crop a picture to its centred square and scale it to 256×256.
 *
 * Exported as WebP, or PNG where the browser's canvas cannot encode WebP (older Safari
 * hands back a PNG or nothing). Either way the result is tens of kilobytes, so the
 * server's 512 KB limit is never what stops a large phone photo.
 */
async function toAvatarBlob(file: File): Promise<Blob> {
  const img = await loadImage(file);
  const side = Math.min(img.naturalWidth, img.naturalHeight);
  if (side === 0) throw new Error("That image is empty");

  const canvas = document.createElement("canvas");
  canvas.width = AVATAR_SIZE;
  canvas.height = AVATAR_SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This browser cannot resize images");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(
    img,
    (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side,
    0, 0, AVATAR_SIZE, AVATAR_SIZE,
  );

  const webp = await canvasToBlob(canvas, "image/webp", 0.9);
  if (webp && webp.type === "image/webp") return webp;
  const png = await canvasToBlob(canvas, "image/png");
  if (!png) throw new Error("This browser could not encode the image");
  return png;
}

/**
 * The avatar on the Account page: the current picture at 80 px, Change and Remove.
 *
 * Change picks a file, crops and resizes it in the browser, shows the result as a preview,
 * and uploads only when the user confirms it. Remove has an inline confirm step. The auth
 * store gets the new URL after either, so the top bar updates at once.
 */
export function AvatarEditor() {
  const username     = useAuthStore(s => s.username);
  const avatarUrl    = useAuthStore(s => s.avatarUrl);
  const setAvatarUrl = useAuthStore(s => s.setAvatarUrl);

  const [preview, setPreview]   = useState<{ blob: Blob; url: string } | null>(null);
  const [busy, setBusy]         = useState<"prepare" | "upload" | "remove" | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const inputRef  = useRef<HTMLInputElement>(null);
  // Cropping is async; if the page is left meanwhile, the preview's cleanup has already run
  // and a URL created afterwards would never be released.
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  // The preview's object URL is released when it is replaced and when the page is left.
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview.url); }, [preview]);

  const toast = (message: string, type: "success" | "error") => useToastStore.getState().push(message, type);

  const onPick = async (file: File | undefined) => {
    // Cleared at once so picking the same file again still fires a change.
    if (inputRef.current) inputRef.current.value = "";
    if (!file) return;
    if (!ACCEPTED_TYPES.includes(file.type)) {
      toast("Choose a PNG, JPEG or WebP image", "error");
      return;
    }
    setConfirmRemove(false);
    setBusy("prepare");
    try {
      const blob = await toAvatarBlob(file);
      if (!mounted.current) return;
      setPreview({ blob, url: URL.createObjectURL(blob) });
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not read the image", "error");
    } finally {
      setBusy(null);
    }
  };

  const upload = async () => {
    if (!preview) return;
    setBusy("upload");
    try {
      const ext = preview.blob.type === "image/webp" ? "webp" : "png";
      const file = new File([preview.blob], `avatar.${ext}`, { type: preview.blob.type });
      const { data, error } = await api.api.auth.avatar.put({ file });
      if (error) {
        toast((error.value as { error?: string })?.error ?? "Could not upload the avatar", "error");
        return;
      }
      const url = (data as { avatarUrl?: string } | null)?.avatarUrl;
      if (url) setAvatarUrl(url);
      setPreview(null);
      toast("Avatar updated", "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not upload the avatar", "error");
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    setBusy("remove");
    try {
      const { error } = await api.api.auth.avatar.delete();
      if (error) {
        toast((error.value as { error?: string })?.error ?? "Could not remove the avatar", "error");
        return;
      }
      setAvatarUrl(null);
      setConfirmRemove(false);
      toast("Avatar removed", "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not remove the avatar", "error");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex items-center gap-4 flex-wrap">
      <Avatar url={avatarUrl} username={username} size={80} alt="Your avatar" />

      {preview ? (
        <div className="flex items-center gap-3">
          <img
            src={preview.url}
            alt="Preview of your new avatar"
            width={48}
            height={48}
            className="w-12 aspect-square h-auto max-w-full rounded-full object-cover border border-blue-500/50"
          />
          <div className="flex flex-col gap-1.5">
            <p className="text-[11px] text-gray-500">Cropped to a square, 256×256.</p>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                autoFocus
                onClick={() => void upload()}
                disabled={busy !== null}
                className={PRIMARY_BUTTON}
              >
                {busy === "upload" ? <Loader2 size={12} className="animate-spin" /> : <Upload size={12} />}
                {busy === "upload" ? "Uploading…" : "Use this avatar"}
              </button>
              <button
                type="button"
                onClick={() => setPreview(null)}
                disabled={busy !== null}
                className={QUIET_BUTTON}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-1.5 flex-wrap">
          {/* A label styled as a button, so the native picker opens from click, Enter or
              Space and the visible text names the control. */}
          <label className={`${QUIET_BUTTON} cursor-pointer focus-within:ring-2 focus-within:ring-blue-500 ${busy !== null ? "opacity-40 pointer-events-none" : ""}`}>
            <input
              ref={inputRef}
              type="file"
              accept={ACCEPTED_TYPES.join(",")}
              disabled={busy !== null}
              onChange={e => void onPick(e.target.files?.[0])}
              className="sr-only"
            />
            {busy === "prepare" ? <Loader2 size={12} className="animate-spin" /> : <ImageUp size={12} />}
            {avatarUrl ? "Change avatar" : "Upload avatar"}
          </label>

          {avatarUrl && (
            <InlineConfirm
              label="Remove"
              icon={<Trash2 size={12} />}
              confirmLabel="Remove avatar"
              busyLabel="Removing…"
              subject="your avatar"
              confirming={confirmRemove}
              busy={busy === "remove"}
              disabled={busy !== null}
              onAsk={() => setConfirmRemove(true)}
              onCancel={() => setConfirmRemove(false)}
              onConfirm={() => void remove()}
            />
          )}
        </div>
      )}
    </div>
  );
}
