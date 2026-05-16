import { db } from "../db";
import { sambaShares } from "../db/schema";
import { eq } from "drizzle-orm";
import type { SambaShareRow, NewSambaShareRow } from "../db/schema";

export class SambaShareStore {
  static async findAll(): Promise<SambaShareRow[]> {
    return db.select().from(sambaShares).orderBy(sambaShares.createdAt);
  }

  static async findByName(name: string): Promise<SambaShareRow | null> {
    const rows = await db
      .select()
      .from(sambaShares)
      .where(eq(sambaShares.name, name))
      .limit(1);
    return rows[0] ?? null;
  }

  static async create(data: Omit<NewSambaShareRow, "id" | "createdAt">): Promise<SambaShareRow> {
    const rows = await db.insert(sambaShares).values(data).returning();
    const row = rows[0];
    if (!row) throw new Error("Failed to insert samba share");
    return row;
  }

  static async deleteByName(name: string): Promise<boolean> {
    const rows = await db
      .delete(sambaShares)
      .where(eq(sambaShares.name, name))
      .returning();
    return rows.length > 0;
  }

  static async updateByName(name: string, data: Partial<Pick<SambaShareRow, "comment" | "readOnly" | "browseable">>): Promise<SambaShareRow | null> {
    const rows = await db
      .update(sambaShares)
      .set(data)
      .where(eq(sambaShares.name, name))
      .returning();
    return rows[0] ?? null;
  }
}
