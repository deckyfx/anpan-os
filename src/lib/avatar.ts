import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { envConfig } from "../env-config";
import type { User } from "../db/schema";

/**
 * Profile pictures: sniffing, storage and the URL the client shows them by.
 *
 * The bytes live on disk under RUNTIME_CONFIG_DIR/avatars, one file per user named by id
 * alone, so no user-supplied name ever reaches a path. The users row records only the type
 * and when it changed.
 */

/** The only types accepted. No SVG: an SVG is a document that can carry script. */
export const AVATAR_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export type AvatarType = (typeof AVATAR_TYPES)[number];

/** 512 KB — plenty for a picture shown at 40 px, small enough to read whole into memory. */
export const AVATAR_MAX_BYTES = 512 * 1024;

/**
 * The image type the bytes themselves declare, or null.
 *
 * The client's Content-Type and file name are whatever it chose to send; a GIF, an SVG or an
 * HTML page renamed to .png arrives labelled image/png. The magic bytes are the one part of
 * the upload that has to be true for a browser to decode it as that format.
 */
export function sniffAvatarType(bytes: Uint8Array): AvatarType | null {
  const at = (i: number, ...sig: number[]) => sig.every((b, j) => bytes[i + j] === b);
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  // RIFF <4-byte size> WEBP
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
  return null;
}

/** Where avatars are kept. Read on each call so tests can point RUNTIME_CONFIG_DIR elsewhere. */
function avatarDir(): string {
  return join(envConfig.RUNTIME_CONFIG_DIR, "avatars");
}

/** The file holding `userId`'s avatar. */
export function avatarPath(userId: number): string {
  return join(avatarDir(), String(userId));
}

/**
 * Store `bytes` as `userId`'s avatar.
 *
 * Written to a temporary file beside the target and renamed over it, so a reader — or a
 * crash — never sees half a picture: rename within one directory is atomic. The directory is
 * 0700 and the file 0600 because nothing but this service has reason to read them.
 */
export async function writeAvatar(userId: number, bytes: Uint8Array): Promise<void> {
  const dir = avatarDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // mkdir's mode applies only when it creates the directory, and is masked by the umask.
  await chmod(dir, 0o700);
  const tmp = join(dir, `.${userId}.${crypto.randomUUID()}.tmp`);
  try {
    await writeFile(tmp, bytes, { mode: 0o600, flag: "wx" });
    await rename(tmp, avatarPath(userId));
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

/** Remove `userId`'s avatar file. A file already gone is not an error. */
export async function removeAvatar(userId: number): Promise<void> {
  await rm(avatarPath(userId), { force: true });
}

/** Remove every avatar — for wiping all users at once (`--reset-user`). */
export async function removeAllAvatars(): Promise<void> {
  await rm(avatarDir(), { recursive: true, force: true });
}

/**
 * The URL the client shows `user`'s avatar by, or null when there is none.
 *
 * Versioned by the change time, so the avatar can be cached as immutable and a new upload is
 * still seen at once: it is a new URL.
 */
export function avatarUrlOf(user: Pick<User, "avatarType" | "avatarUpdatedAt">): string | null {
  if (!user.avatarType || !user.avatarUpdatedAt) return null;
  return `/api/auth/avatar?v=${Math.floor(user.avatarUpdatedAt.getTime() / 1000)}`;
}
