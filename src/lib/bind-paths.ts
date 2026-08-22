/**
 * Safety checks for deleting a stack's bind-mounted host directories.
 *
 * Removing a stack has always left its bind mounts on disk, which is why deleting a stack
 * can free almost nothing while gigabytes remain under /DATA/AppData. Offering to delete
 * them is useful, but it is the most destructive thing this application can do: a named
 * volume can be recreated from a compose file, and a bind directory holds the only copy of
 * whatever the user put there.
 *
 * Everything here therefore refuses by default and explains why. A path is deletable only
 * if it passes every check.
 */

import { realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { homedir } from "node:os";
import { config } from "../config";
import { DockerClient } from "./docker";

/** Mounts every stack has; never candidates for deletion. */
export const INFRA_MOUNTS = new Set([
  "/var/run/docker.sock", "/etc/localtime", "/etc/timezone", "/etc/hosts", "/etc/hostname",
]);

/**
 * Directories that must never be deleted even when a stack legitimately mounts them.
 *
 * These are shared roots: /DATA/AppData holds every app's data, so deleting it because one
 * stack mounted it would destroy the rest. Compared canonically, so a symlink to one of
 * them is caught too.
 */
/**
 * Directories refused as candidates, though what lies *below* them may be deletable.
 *
 * These are containers for data: /DATA/AppData holds every app's directory, so deleting
 * the parent would take them all, while /DATA/AppData/myapp is exactly the normal case.
 */
const PROTECTED = [
  "/", "/home", "/mnt", "/media", "/srv", "/tmp",
  "/DATA", "/DATA/AppData", "/DATA/Media",
  homedir(),
];

/**
 * Roots whose entire subtree is refused.
 *
 * `config.filesRoot` defaults to "/", and the depth rule only requires two segments below
 * the root — so without this, /etc/nginx, /usr/local and /var/www all qualify and a stack
 * mounting one would offer to delete it. Nothing a container legitimately owns lives under
 * these; application data belongs in /DATA, a home directory, or a mounted disk.
 */
const SYSTEM_ROOTS = [
  "/etc", "/usr", "/var", "/opt", "/boot", "/dev", "/proc", "/sys", "/run",
  "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32", "/root", "/snap",
];

/**
 * Personal directories, refused even though a stack legitimately mounts them.
 *
 * A media server mounts a music or video library as *input*: the library is the reason the
 * stack exists, not state the stack owns, and removing the stack must never offer to
 * delete it. The read-write flag cannot distinguish these — media stacks routinely mount
 * libraries read-write — so the directory's identity is the only reliable signal.
 *
 * Deleting one of these deliberately is still possible through the file manager, which is
 * the right place for it: there the user names the directory, rather than accepting a
 * checkbox attached to something else.
 */
const PERSONAL_DIR_NAMES = new Set([
  "Music", "Videos", "Pictures", "Documents", "Downloads", "Desktop", "Public",
  "Templates", "Movies", "Media", "Photos", "Books",
]);

/** Minimum depth below the files root, so a stack cannot nominate the root itself. */
const MIN_SEGMENTS_BELOW_ROOT = 2;

export type BindVerdict =
  | { path: string; deletable: true;  canonical: string }
  | { path: string; deletable: false; reason: string };

function segmentsBelow(root: string, path: string): number {
  const r = root.endsWith(sep) ? root.slice(0, -1) : root;
  if (path === r) return 0;
  if (!path.startsWith(r + sep)) return -1;
  return path.slice(r.length + 1).split(sep).filter(Boolean).length;
}

/**
 * Canonical form of a path, following symlinks.
 *
 * `guardPath()` in routeFiles does a lexical resolve-and-prefix-compare, which is fine for
 * reading and writing but not for deleting: a directory inside the files root may be a
 * symlink pointing anywhere, and the lexical check would pass it. Deleting follows that
 * link. A path that cannot be canonicalised does not exist, and is reported rather than
 * assumed safe.
 */
async function canonicalise(path: string): Promise<string | null> {
  try {
    return await realpath(resolve(path));
  } catch {
    return null;
  }
}

/**
 * Decide whether one bind path may be deleted.
 *
 * `otherStackPaths` are the canonical bind paths of every *other* project on the host.
 * Sharing is the case most likely to cause silent damage: two stacks mounting the same
 * data directory is ordinary, and deleting it with one of them takes the other's data too.
 */
export async function judgeBindPath(
  path: string,
  otherStackPaths: Set<string>,
  /**
   * Files root to judge against. Defaults to the configured one; overridable so the
   * escape and depth rules can be tested, which is impossible when the root is "/"
   * because nothing is outside it and everything is deep enough.
   */
  filesRoot?: string,
): Promise<BindVerdict> {
  if (INFRA_MOUNTS.has(path)) {
    return { path, deletable: false, reason: "System mount shared by every container" };
  }

  const canonical = await canonicalise(path);
  if (!canonical) {
    return { path, deletable: false, reason: "Path no longer exists on disk" };
  }

  if (PROTECTED.includes(canonical)) {
    return { path, deletable: false, reason: `${canonical} is a shared system directory` };
  }

  // Anything inside a system root, at any depth. Exact-match protection was not enough:
  // with the default files root of "/", /etc/nginx sits two segments down and passed.
  for (const root of SYSTEM_ROOTS) {
    if (canonical === root || canonical.startsWith(root + sep)) {
      return { path, deletable: false, reason: `${root} is a system directory` };
    }
  }

  // A top-level directory in someone's home — /home/decky/Music — is a personal library
  // the stack consumes, not data it owns.
  const home = homedir();
  if (canonical.startsWith(home + sep)) {
    const rest = canonical.slice(home.length + 1).split(sep).filter(Boolean);
    if (rest.length === 1 && PERSONAL_DIR_NAMES.has(rest[0]!)) {
      return { path, deletable: false, reason: `${canonical} is a personal library, not stack data` };
    }
  }

  const root = filesRoot ?? config.filesRoot;
  if (root !== "/") {
    const canonicalRoot = await canonicalise(root);
    if (!canonicalRoot || !(canonical === canonicalRoot || canonical.startsWith(canonicalRoot + sep))) {
      return { path, deletable: false, reason: "Outside the configured files root" };
    }
  }

  // Depth is measured against the canonical path, so "/DATA/AppData/x/../.." cannot
  // masquerade as something deep.
  const depth = segmentsBelow(root === "/" ? "/" : root, canonical);
  if (depth < MIN_SEGMENTS_BELOW_ROOT) {
    return {
      path,
      deletable: false,
      reason: `Too close to the filesystem root to delete safely (${canonical})`,
    };
  }

  if (otherStackPaths.has(canonical)) {
    return { path, deletable: false, reason: "Also mounted by another stack" };
  }
  // Containment is dangerous in both directions. A parent of another stack's path takes
  // the child with it; a path *inside* another stack's mount is data that stack is using,
  // even though the two strings are not equal — /DATA/AppData/shared/db sits inside
  // /DATA/AppData/shared.
  for (const other of otherStackPaths) {
    if (canonical.startsWith(other + sep)) {
      return { path, deletable: false, reason: `Inside another stack's data (${other})` };
    }
    if (other.startsWith(canonical + sep)) {
      return { path, deletable: false, reason: `Contains another stack's data (${other})` };
    }
  }

  return { path, deletable: true, canonical };
}

/** Canonical bind paths belonging to every project except `exceptStack`. */
export async function otherStacksBindPaths(exceptStack: string): Promise<Set<string>> {
  const out = new Set<string>();
  const containers = await DockerClient.listContainers();
  if (!containers.ok) return out;

  const foreign = containers.data.filter(
    c => (c.Labels?.["com.docker.compose.project"] ?? "") !== exceptStack,
  );

  const inspected = await Promise.all(foreign.map(c => DockerClient.inspectContainer(c.Id)));
  for (const r of inspected) {
    if (!r.ok) continue;
    for (const m of r.data.Mounts) {
      if (m.Type !== "bind" || INFRA_MOUNTS.has(m.Source)) continue;
      const canonical = await canonicalise(m.Source);
      if (canonical) out.add(canonical);
    }
  }
  return out;
}

/**
 * Judge every bind path of a stack.
 *
 * Read from Docker rather than from a list the client supplied: the browser's copy may be
 * minutes old, and a request to delete a path is not evidence that the path still belongs
 * to the stack.
 */
export async function judgeStackBindPaths(stack: string): Promise<BindVerdict[]> {
  const containers = await DockerClient.listProjectContainers(stack);
  if (!containers.ok) return [];

  const sources = new Set<string>();
  const inspected = await Promise.all(containers.data.map(c => DockerClient.inspectContainer(c.Id)));
  for (const r of inspected) {
    if (!r.ok) continue;
    for (const m of r.data.Mounts) {
      if (m.Type === "bind" && !INFRA_MOUNTS.has(m.Source)) sources.add(m.Source);
    }
  }

  const others = await otherStacksBindPaths(stack);
  return Promise.all([...sources].sort().map(p => judgeBindPath(p, others)));
}
