import { eq, sql } from "drizzle-orm";
import { db } from "../db/index";
import { stacks } from "../db/schema";
import type { Stack, NewStack } from "../db/schema";

export class StackStore {
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
}
