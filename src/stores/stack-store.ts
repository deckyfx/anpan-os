import { eq, sql } from "drizzle-orm";
import { db } from "../db/index";
import { imageUpdateState, stacks } from "../db/schema";
import type { Stack, NewStack } from "../db/schema";
import { UpdateCheckStore } from "./update-check-store";

/** When each stack was last deleted, so a listing already in flight cannot re-add it. */
const deletedAt = new Map<string, number>();

export class StackStore {
  /**
   * Whether `id` was deleted at or after `since`.
   *
   * GET /api/docker/stacks lists Docker and then upserts every name it saw. A listing taken
   * before a stack's containers were removed, landing after Forget, would otherwise put the
   * forgotten row straight back.
   */
  static deletedSince(id: string, since: number): boolean {
    return (deletedAt.get(id) ?? -Infinity) >= since;
  }

  static async findAll(): Promise<Stack[]> {
    return db.select().from(stacks);
  }

  static async findById(id: string): Promise<Stack | null> {
    const rows = await db.select().from(stacks).where(eq(stacks.id, id)).limit(1);
    return rows[0] ?? null;
  }

  /**
   * Upsert a stack row from Docker sync.
   * Metadata fields (icon, title, …) use COALESCE so they only seed on first insert
   * and never overwrite values the user has already set.
   */
  static async upsert(data: NewStack): Promise<Stack> {
    const result = await db
      .insert(stacks)
      .values(data)
      .onConflictDoUpdate({
        target: stacks.id,
        set: {
          // COALESCE keeps the existing DB value when it's not null, falling back to
          // the incoming (Docker-sourced) value only when the column is still empty.
          icon:        sql`COALESCE(${stacks.icon},        excluded.icon)`,
          title:       sql`COALESCE(${stacks.title},       excluded.title)`,
          tagline:     sql`COALESCE(${stacks.tagline},     excluded.tagline)`,
          portMap:     sql`COALESCE(${stacks.portMap},     excluded.port_map)`,
          scheme:      sql`COALESCE(${stacks.scheme},      excluded.scheme)`,
          indexPath:   sql`COALESCE(${stacks.indexPath},   excluded.index_path)`,
          mainService: sql`COALESCE(${stacks.mainService}, excluded.main_service)`,
          address:     sql`COALESCE(${stacks.address},     excluded.address)`,
          updatedAt:   new Date(),
        },
      })
      .returning();
    if (!result[0]) throw new Error(`upsert failed for stack ${data.id}`);
    return result[0];
  }

  static async updateMeta(id: string, patch: Partial<Omit<NewStack, "id">>): Promise<Stack | null> {
    const result = await db
      .update(stacks)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(stacks.id, id))
      .returning();
    return result[0] ?? null;
  }

  /**
   * Remove a stack's row and everything else keyed by its id.
   *
   * The update-check results go too: they are keyed by stack name, not linked to this row,
   * so leaving them meant the update report went on listing a deleted stack until the next
   * full sweep happened to prune it.
   */
  static async delete(id: string): Promise<void> {
    // One transaction: if the second delete failed after the first committed, a retry would
    // find no row, answer 404, and never clear the results.
    db.transaction(tx => {
      tx.delete(stacks).where(eq(stacks.id, id)).run();
      tx.delete(imageUpdateState).where(eq(imageUpdateState.stack, id)).run();
    });
    const now = Date.now();
    deletedAt.set(id, now);
    for (const [name, t] of deletedAt) if (now - t > 60 * 60_000) deletedAt.delete(name);
    UpdateCheckStore.fenceStack(id, now);
  }
}
