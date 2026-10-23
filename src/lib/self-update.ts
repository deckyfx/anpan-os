import { dirname, join } from "node:path";
import { chmod, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { binaryName, currentBinaryPath } from "./platform";
import { DirLock, LockBusyError } from "./dir-lock";

/**
 * Replacing the installed binary with the latest release.
 *
 * One implementation, used by both the web updater (POST /api/system/update) and
 * `anpan-os --upgrade`. Kept in one place so the two cannot drift: each step below exists
 * because a version without it broke an install.
 */

const LATEST_RELEASE_URL = "https://api.github.com/repos/deckyfx/anpan-os/releases/latest";

/** A step of the update failed. `status` is what the web route answers with. */
export class UpdateError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/**
 * Fetch, turning a network failure into an UpdateError.
 *
 * Unreachable GitHub, a timeout or a reset connection otherwise escaped as a bare TypeError:
 * the web route answered it as a server crash (500, with a stack trace in the log) and the
 * CLI printed the raw exception. It is an upstream failure, so 502 with what was attempted.
 */
async function fetchUpstream(fetchImpl: typeof fetch, url: string, init: RequestInit, what: string): Promise<Response> {
  try {
    return await fetchImpl(url, init);
  } catch (e) {
    throw new UpdateError(`Could not reach GitHub to ${what}: ${e instanceof Error ? e.message : String(e)}`, 502);
  }
}

/** Whether version `candidate` is newer than `current`. Tolerates a leading "v". */
export function isNewer(candidate: string, current: string): boolean {
  const parse = (v: string) => v.replace(/^v/, "").split(".").map(n => Number.parseInt(n, 10) || 0);
  const [aMaj = 0, aMin = 0, aPatch = 0] = parse(candidate);
  const [bMaj = 0, bMin = 0, bPatch = 0] = parse(current);
  if (aMaj !== bMaj) return aMaj > bMaj;
  if (aMin !== bMin) return aMin > bMin;
  return aPatch > bPatch;
}

/** The latest release, and its download for *this* machine. */
export interface LatestRelease {
  version: string;
  notes: string;
  /** Asset name for this OS and architecture, e.g. anpan-os-linux-x64. */
  asset: string;
  /** Empty when the release has no asset for this machine. */
  binaryUrl: string;
  sha256Url: string;
}

/** Look up the latest release on GitHub. */
export async function fetchLatestRelease(fetchImpl: typeof fetch = fetch): Promise<LatestRelease> {
  const res = await fetchUpstream(fetchImpl, LATEST_RELEASE_URL, {
    headers: { "User-Agent": "anpan-os" },
    signal: AbortSignal.timeout(15_000),
  }, "look up the latest release");
  if (!res.ok) throw new UpdateError(`GitHub API returned ${res.status}`, 502);

  const data = await res.json() as {
    tag_name?: string;
    body?: string;
    assets?: { name: string; browser_download_url: string }[];
  };

  // The asset for this host, not always the Linux one: a Linux ELF installed on a Mac and
  // marked executable produces a service that cannot start.
  const asset  = binaryName();
  const assets = data.assets ?? [];
  return {
    version:   (data.tag_name ?? "").replace(/^v/, ""),
    notes:     data.body ?? "",
    asset,
    binaryUrl: assets.find(a => a.name === asset)?.browser_download_url ?? "",
    sha256Url: assets.find(a => a.name === `${asset}.sha256`)?.browser_download_url ?? "",
  };
}

/**
 * Download the release binary and verify it against its published SHA-256.
 *
 * Read as a stream so a caller can show progress, and hashed as it arrives. A mismatch is
 * refused before anything touches the installed binary.
 */
export async function downloadVerified(
  release: LatestRelease,
  onProgress?: (received: number, total: number | null) => void,
  fetchImpl: typeof fetch = fetch,
): Promise<Uint8Array> {
  if (!release.binaryUrl || !release.sha256Url) {
    throw new UpdateError(`No release asset found for ${release.asset}`, 404);
  }

  const sumRes = await fetchUpstream(fetchImpl, release.sha256Url, { signal: AbortSignal.timeout(15_000) }, "download the checksum");
  if (!sumRes.ok) throw new UpdateError("Failed to download checksum file", 502);
  const expected = (await sumRes.text()).trim().split(/\s+/)[0] ?? "";

  // Ten minutes: the binary is about 90 MB, and a whole-download limit of two minutes failed
  // anything slower than about 0.75 MB/s.
  const binRes = await fetchUpstream(fetchImpl, release.binaryUrl, { signal: AbortSignal.timeout(600_000) }, "download the binary");
  if (!binRes.ok || !binRes.body) throw new UpdateError("Failed to download binary", 502);

  const total  = Number(binRes.headers.get("content-length")) || null;
  const hasher = new Bun.CryptoHasher("sha256");
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    for await (const chunk of binRes.body) {
      hasher.update(chunk);
      chunks.push(chunk);
      received += chunk.byteLength;
      onProgress?.(received, total);
    }
  } catch (e) {
    // The connection can also drop part-way, after the response has started.
    throw new UpdateError(`Download interrupted after ${received} bytes: ${e instanceof Error ? e.message : String(e)}`, 502);
  }

  if (hasher.digest("hex") !== expected) {
    throw new UpdateError("SHA256 mismatch — download may be corrupted", 422);
  }

  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

/**
 * Put `bytes` in place of the binary at `target`, atomically.
 *
 * Staged beside the target, never in the temp directory. rename() is atomic only within one
 * filesystem, and the temp directory is routinely on another — tmpfs on Linux, a per-user
 * sandbox on macOS, or wherever TMPDIR points. Across filesystems a move silently degrades to
 * copy-then-unlink, so a crash, a full disk or a kill part-way through leaves a half-written
 * executable at the exact path the service launches from. Staged beside it, the final step is
 * a same-filesystem rename, which happens completely or not at all.
 */
export async function installBinary(bytes: Uint8Array, target: string = currentBinaryPath()): Promise<void> {
  // Unique and dotted, so a partial file is neither picked up nor mistaken for the binary.
  const staged = join(dirname(target), `.anpan-os-update-${process.pid}-${randomUUID()}`);
  try {
    await Bun.write(staged, bytes);
    await chmod(staged, 0o755);
    await rename(staged, target);
  } catch (e) {
    // The staged file is ours alone; leaving it would accumulate a copy of the binary beside
    // the real one on every failed update.
    await rm(staged, { force: true }).catch(() => {});
    throw new UpdateError(`Could not replace ${target}: ${e instanceof Error ? e.message : String(e)}`, 500);
  }
}

/**
 * Run `fn` holding the update lock, or fail at once if another update holds it.
 *
 * The web updater and `anpan-os --upgrade` run in different processes, so a flag inside one
 * cannot stop the other: two writers on one binary is how an install ends up with a partial
 * executable. The lock sits beside the binary both replace, since that is the one thing they
 * certainly share. It refuses rather than waits — a second update of the same binary has
 * nothing to add.
 */
export async function withUpdateLock<T>(fn: () => Promise<T>, target: string = currentBinaryPath()): Promise<T> {
  const lock = new DirLock({
    lockDir:    join(dirname(target), ".anpan-os-update.lock"),
    reclaimDir: join(dirname(target), ".anpan-os-update.reclaim"),
    waitMs:     0,
  });
  try {
    return await lock.run(fn);
  } catch (err) {
    if (err instanceof LockBusyError) throw new UpdateError("An update is already in progress.", 409);
    throw err;
  }
}
