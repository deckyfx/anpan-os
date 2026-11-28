/**
 * Host folders a job is working on, so two jobs on different stacks do not act on the same
 * files at once.
 *
 * A restore replaces an app's folders, and a deploy of another stack may be about to mount
 * one of them: each holds a reservation on its folders for as long as it runs, and refuses
 * to start on a folder another stack holds. Jobs on the same stack are already kept apart
 * by the job manager's stack claims, so only other stacks' reservations count.
 *
 * Paths are compared as given; callers pass them with links followed.
 */
import { isAbsolute, relative } from "node:path";

interface Reservation {
  stack: string;
  what:  string;
  paths: string[];
}

const held = new Set<Reservation>();

/** Whether `a` and `b` are one folder, or one is inside the other. */
function overlaps(a: string, b: string): boolean {
  const inside = (child: string, parent: string) => {
    const rel = relative(parent, child);
    return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith("../"));
  };
  return inside(a, b) || inside(b, a);
}

/**
 * Reserve `paths` for `stack`. Returns a release function, or the reservation in the way
 * (another stack's, on a path that is, contains or lies in one of these).
 */
export function reservePaths(stack: string, what: string, paths: string[]):
  { ok: true; release: () => void } | { ok: false; conflict: { stack: string; what: string; path: string } } {
  for (const r of held) {
    if (r.stack === stack) continue;
    const path = r.paths.find(p => paths.some(q => overlaps(p, q)));
    if (path) return { ok: false, conflict: { stack: r.stack, what: r.what, path } };
  }
  const mine: Reservation = { stack, what, paths };
  held.add(mine);
  return { ok: true, release: () => { held.delete(mine); } };
}
