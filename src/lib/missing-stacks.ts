import type { Stack } from "../db/schema";

/** A stack anpan-os still holds metadata for, but which Docker no longer has. */
export interface MissingStack {
  id: string;
  title: string | null;
  icon: string | null;
  /** Installed or imported through anpan-os, rather than discovered from Docker. */
  managed: boolean;
  /** The stack's folder still exists in the compose folder, so it could be redeployed. */
  composeOnDisk: boolean;
}

/**
 * The stack rows with no container behind them.
 *
 * The stack list is built from what Docker reports, so a row whose containers were
 * removed outside anpan-os (a `docker compose down`, or the folder deleted by hand) is
 * never shown and so can never be deleted from the UI. This finds those rows.
 *
 * `liveNames` must come from a successful Docker listing. An empty set is a valid answer
 * on a host with no containers, so it is the caller's job not to pass one in when the
 * listing failed, because then every row would look missing.
 */
export function findMissingStacks(
  rows: readonly Stack[],
  liveNames: ReadonlySet<string>,
  composeOnDisk: (id: string) => boolean,
): MissingStack[] {
  return rows
    .filter(r => !liveNames.has(r.id))
    .map(r => ({
      id: r.id,
      title: r.title,
      icon: r.icon,
      managed: r.managed,
      composeOnDisk: composeOnDisk(r.id),
    }))
    // Managed stacks first: those are the ones a person installed and will be looking for.
    // Discovered rows are mostly leftovers from containers that were only ever tried out.
    .sort((a, b) => Number(b.managed) - Number(a.managed) || a.id.localeCompare(b.id));
}
