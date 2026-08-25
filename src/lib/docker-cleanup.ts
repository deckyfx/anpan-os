/**
 * Docker disk usage and reclamation.
 *
 * Docker accumulates a great deal that nothing references — this host carries roughly 41 GB
 * of it — and until now anpan-os offered no way to see or reclaim any of it.
 *
 * The categories are deliberately separate rather than a single "clean up" button, because
 * they are not equally safe. Dangling images and build cache are byproducts nothing can
 * miss. Unused *volumes* are a different matter: "unused" means no container currently
 * references them, which on a host with stopped stacks describes their databases. Losing
 * those is unrecoverable, so volumes are never part of a bulk action and must be asked for
 * by name.
 */

import { DOCKER_SOCKET } from "./platform";

/**
 * Where the daemon listens.
 *
 * Not a constant path any more: Docker Desktop, OrbStack, Colima and Rancher Desktop
 * each put the socket somewhere under the user's home on macOS, and only Docker
 * Desktop reliably links /var/run/docker.sock to it. See lib/platform.
 */
const SOCKET = DOCKER_SOCKET;
const BASE   = "http://localhost";

export type CleanupCategory =
  | "dangling-images"
  | "unused-images"
  | "build-cache"
  | "stopped-containers"
  | "unused-networks"
  | "unused-volumes";

export interface CategoryUsage {
  category: CleanupCategory;
  label: string;
  /** Bytes that would be freed. */
  reclaimable: number;
  /** How many objects the category covers. */
  count: number;
  /** True when removal can destroy something the user would want back. */
  risky: boolean;
  /**
   * True when `reclaimable` is an upper bound rather than an exact figure.
   *
   * Image sizes are summed per image, but layers are shared between them, so the total
   * counts a shared layer once per image that references it. Docker only reports
   * SharedSize when asked, and even then the arithmetic depends on which images go
   * together — so this is presented as an estimate rather than a promise.
   */
  approximate?: boolean;
  /** Shown in the UI beneath the label. */
  note: string;
}

export interface DiskUsage {
  categories: CategoryUsage[];
  totalReclaimable: number;
}

interface DfImage    { Id: string; RepoTags: string[] | null; Size: number; Containers: number }
interface DfContainer{ Id: string; State: string; SizeRw?: number }
interface DfVolume   { Name: string; UsageData?: { Size: number; RefCount: number } | null }
interface DfCache    { ID: string; Size: number; InUse: boolean }
interface DfResponse {
  Images?: DfImage[] | null;
  Containers?: DfContainer[] | null;
  Volumes?: DfVolume[] | null;
  BuildCache?: DfCache[] | null;
}

/** A stalled socket must not hold the whole panel: getDiskUsage awaits four requests. */
const DAEMON_TIMEOUT_MS = 15_000;

async function api<T>(path: string, method = "GET"): Promise<T | null> {
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      unix: SOCKET,
      signal: AbortSignal.timeout(DAEMON_TIMEOUT_MS),
    } as RequestInit);
    if (!res.ok) return null;
    return await res.json() as T;
  } catch {
    return null;
  }
}

/**
 * Current reclaimable space, by category.
 *
 * Computed from /system/df rather than the individual list endpoints so the figures agree
 * with `docker system df`, which is what a user will compare against.
 */
export async function getDiskUsage(): Promise<DiskUsage | null> {
  // /system/df on this API version reports only images that are in use, so unused images
  // cannot be derived from it. The full image list and the container list give the same
  // answer `docker system df` prints, without depending on which images df chose to
  // include.
  const [df, allImages, allContainers, allNetworks] = await Promise.all([
    api<DfResponse>("/system/df"),
    // all=1: without it the list omits non-final images, and the preview would understate
    // what a prune removes.
    api<Array<{ Id: string; RepoTags: string[] | null; Size: number }>>("/images/json?all=1"),
    api<Array<{ ImageID: string; State: string }>>("/containers/json?all=1"),
    // /system/df does not report networks at all, so the count has to come from here or
    // the category can never be enabled in the UI.
    api<Array<{ Name: string; Containers?: Record<string, unknown> | null }>>("/networks?filters=" +
      encodeURIComponent(JSON.stringify({ dangling: ["true"] }))),
  ]);
  if (!df) return null;

  const images     = allImages     ?? [];
  const containers = df.Containers ?? [];
  const volumes    = df.Volumes    ?? [];
  const cache      = df.BuildCache ?? [];

  // An image is in use if any container — running or stopped — was created from it.
  // Stopped containers count: their image is needed to start them again.
  const inUse = new Set((allContainers ?? []).map(c => c.ImageID));

  // Dangling: no repository tags, *and* unreferenced. A container can run an untagged
  // image — this host has one — and Docker refuses to remove an image in use, so counting
  // it here would advertise space that no prune can reclaim.
  const untagged = (i: { RepoTags: string[] | null }) =>
    !i.RepoTags || i.RepoTags.length === 0 || i.RepoTags[0] === "<none>:<none>";
  const dangling = images.filter(i => untagged(i) && !inUse.has(i.Id));
  // Everything no container references, dangling included. This has to match the prune:
  // filters={"dangling":["false"]} removes *all* unused images, not only tagged ones, so
  // a preview that counted just the tagged ones would understate what disappears.
  const allUnused = images.filter(i => !inUse.has(i.Id));

  // /containers/prune removes containers in a stopped state. "not running" would also
  // sweep in paused and restarting ones, which it leaves alone — so the count would
  // promise more than the action delivers.
  const PRUNABLE_STATES = new Set(["exited", "created", "dead"]);
  const stopped = containers.filter(c => PRUNABLE_STATES.has(c.State));
  const unusedVolumes = volumes.filter(v => (v.UsageData?.RefCount ?? 0) === 0);
  const idleCache = cache.filter(c => !c.InUse);

  const categories: CategoryUsage[] = [
    {
      category: "dangling-images",
      label: "Dangling images",
      reclaimable: dangling.reduce((n, i) => n + (i.Size ?? 0), 0),
      count: dangling.length,
      risky: false,
      approximate: true,
      note: "Untagged layers left behind by rebuilds. Nothing references them.",
    },
    {
      category: "build-cache",
      label: "Build cache",
      reclaimable: idleCache.reduce((n, c) => n + (c.Size ?? 0), 0),
      count: idleCache.length,
      risky: false,
      note: "Rebuilt automatically when needed; removing it only costs time on the next build.",
    },
    {
      category: "stopped-containers",
      label: "Stopped containers",
      reclaimable: stopped.reduce((n, c) => n + (c.SizeRw ?? 0), 0),
      count: stopped.length,
      risky: false,
      note: "Their writable layer only. Volumes and bind mounts are untouched.",
    },
    {
      category: "unused-networks",
      label: "Unused networks",
      reclaimable: 0,   // networks occupy no meaningful disk space
      count: (allNetworks ?? []).length,
      risky: false,
      note: "Networks no container is attached to. Frees no disk space — removes clutter only.",
    },
    {
      category: "unused-images",
      label: "Unused images",
      reclaimable: allUnused.reduce((n, i) => n + (i.Size ?? 0), 0),
      count: allUnused.length,
      risky: true,
      approximate: true,
      note: "Every image no container references, dangling ones included. A stopped stack needs its image back before it can start.",
    },
    {
      category: "unused-volumes",
      label: "Unused volumes",
      reclaimable: unusedVolumes.reduce((n, v) => n + (v.UsageData?.Size ?? 0), 0),
      count: unusedVolumes.length,
      risky: true,
      note: "Includes named volumes, not just anonymous ones. \"Unused\" means no container references them right now — which covers every stopped stack's database. Not recoverable.",
    },
  ];

  return {
    categories,
    // Only the safe categories are summed: presenting a total that includes volumes would
    // invite reclaiming data the user did not mean to lose.
    totalReclaimable: categories.filter(c => !c.risky).reduce((n, c) => n + c.reclaimable, 0),
  };
}

export interface PruneResult {
  category: CleanupCategory;
  reclaimed: number;
  deleted: number;
  error?: string;
}

/** Endpoint and filters for each category. */
function pruneRequest(category: CleanupCategory): { path: string } {
  switch (category) {
    case "dangling-images":
      // Default behaviour of /images/prune is dangling-only.
      return { path: "/images/prune" };
    case "unused-images":
      return { path: `/images/prune?filters=${encodeURIComponent(JSON.stringify({ dangling: ["false"] }))}` };
    case "build-cache":
      // Without all=true the daemon prunes only dangling cache records, a subset of the
      // idle ones this category counts — the same preview/action mismatch as the volumes
      // and images categories had.
      return { path: "/build/prune?all=true" };
    case "stopped-containers":
      return { path: "/containers/prune" };
    case "unused-networks":
      return { path: "/networks/prune" };
    case "unused-volumes":
      // /volumes/prune removes only *anonymous* volumes by default. Without all=true it
      // would delete a fraction of what this category counts and reports as reclaimable —
      // a user confirming "204 volumes, 4 GB" would get a handful of megabytes and no
      // explanation. The count and the action have to describe the same set.
      return { path: `/volumes/prune?filters=${encodeURIComponent(JSON.stringify({ all: ["true"] }))}` };
  }
}

interface PruneResponse {
  SpaceReclaimed?: number;
  ImagesDeleted?: Array<unknown> | null;
  ContainersDeleted?: Array<unknown> | null;
  VolumesDeleted?: Array<unknown> | null;
  NetworksDeleted?: Array<unknown> | null;
  CachesDeleted?: Array<unknown> | null;
}

/** Run one category's prune. One category at a time, so a failure cannot be ambiguous. */
export async function prune(category: CleanupCategory): Promise<PruneResult> {
  const { path } = pruneRequest(category);
  const res = await api<PruneResponse>(path, "POST");
  if (!res) {
    return { category, reclaimed: 0, deleted: 0, error: "Docker refused the prune request" };
  }

  const deleted =
    (res.ImagesDeleted?.length ?? 0) +
    (res.ContainersDeleted?.length ?? 0) +
    (res.VolumesDeleted?.length ?? 0) +
    (res.NetworksDeleted?.length ?? 0) +
    (res.CachesDeleted?.length ?? 0);

  return { category, reclaimed: res.SpaceReclaimed ?? 0, deleted };
}
