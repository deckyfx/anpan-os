/**
 * Containment checks for the file manager's configured root.
 *
 * Comparing spellings is not enough once `files.root` is narrowed below "/": a symlink inside
 * the root that points outside it passes a string-prefix check, and every operation through it
 * — listing, reading, writing — then reaches the rest of the host. Each check below therefore
 * compares canonical paths as well as the spellings given.
 *
 * Two rules, because two kinds of operation exist:
 *
 *  - {@link resolveWithin} is for going *into* a path — list, read, write, upload into, zip.
 *    The whole path is canonicalised, so a link that leaves the root is refused.
 *  - {@link resolveEntryWithin} is for acting on an entry *as itself* — delete, rename, copy or
 *    move. Those operate on a symlink, not its target, so only the parent is canonicalised.
 *    Refusing them outright would make a dangerous link impossible to remove, which is the
 *    first thing anyone would want to do with it.
 *
 * Both return the path as resolved, not canonicalised, so the UI keeps the names the user
 * navigated by. A link swapped between the check and the operation can still win that race;
 * closing it would mean opening every file through the canonical path.
 */

import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/** Raised for a path outside the root. Routes answer any thrown guard error with 403. */
const forbidden = () => new Error("Forbidden");

/**
 * Canonical form of a path that may not exist yet.
 *
 * The deepest existing ancestor goes through realpath; the components below it are appended
 * as written, since a component that does not exist cannot be a symlink.
 */
export function canonicalOf(path: string): string {
  let head = resolve(path);
  const tail: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(head), ...tail);
    } catch {
      const parent = dirname(head);
      if (parent === head) return resolve(path);
      tail.unshift(basename(head));
      head = parent;
    }
  }
}

/** Whether `path` is `root` or lies beneath it. Segment-wise: /data-backup is not in /data. */
function isUnder(path: string, root: string): boolean {
  return root === "/" || path === root || path.startsWith(`${root}/`);
}

/** `input` resolved, if going into it stays inside `root` — through every symlink on the way. */
export function resolveWithin(input: string, root: string): string {
  const resolved = resolve(input);
  const literalRoot = resolve(root);
  if (literalRoot === "/") return resolved;
  if (!isUnder(resolved, literalRoot)) throw forbidden();
  if (!isUnder(canonicalOf(resolved), canonicalOf(literalRoot))) throw forbidden();
  return resolved;
}

/** `input` resolved, if the entry itself lies inside `root`; a final symlink is not followed. */
export function resolveEntryWithin(input: string, root: string): string {
  const resolved = resolve(input);
  const literalRoot = resolve(root);
  if (literalRoot === "/") return resolved;
  if (!isUnder(resolved, literalRoot)) throw forbidden();
  const parent = dirname(resolved);
  const entry = parent === resolved ? resolved : join(canonicalOf(parent), basename(resolved));
  if (!isUnder(entry, canonicalOf(literalRoot))) throw forbidden();
  return resolved;
}
