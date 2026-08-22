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

const SOCKET = "/var/run/docker.sock";
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

async function api<T>(path: string, method = "GET"): Promise<T | null> {
  try {
    const res = await fetch(`${BASE}${path}`, { method, unix: SOCKET } as RequestInit);
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
    api<Array<{ Id: string; RepoTags: string[] | null; Size: number }>>("/images/json"),
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

  // Dangling: no repository tags at all. These are layers left by a rebuild or a retag.
  const dangling = images.filter(i => !i.RepoTags || i.RepoTags.length === 0 || i.RepoTags[0] === "<none>:<none>");
  const danglingIds = new Set(dangling.map(i => i.Id));
  // Unused but tagged: a real image no container references. Removing it means a pull to
  // get it back, which is inconvenient rather than destructive.
  const unusedTagged = images.filter(i => !inUse.has(i.Id) && !danglingIds.has(i.Id));

  const stopped = containers.filter(c => c.State !== "running");
  const unusedVolumes = volumes.filter(v => (v.UsageData?.RefCount ?? 0) === 0);
  const idleCache = cache.filter(c => !c.InUse);

  const categories: CategoryUsage[] = [
    {
      category: "dangling-images",
      label: "Dangling images",
      reclaimable: dangling.reduce((n, i) => n + (i.Size ?? 0), 0),
      count: dangling.length,
      risky: false,
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
      reclaimable: unusedTagged.reduce((n, i) => n + (i.Size ?? 0), 0),
      count: unusedTagged.length,
      risky: true,
      note: "Tagged images no container uses. A stopped stack needs its image back to start again.",
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
      return { path: "/build/prune" };
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
