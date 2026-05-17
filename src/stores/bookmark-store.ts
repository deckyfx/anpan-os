import { db } from "../db";
import { bookmarks } from "../db/schema";
import { eq, asc } from "drizzle-orm";
import type { BookmarkRow, NewBookmarkRow } from "../db/schema";

type CreateInput = Pick<NewBookmarkRow, "title" | "url" | "icon" | "note" | "orderNo">;
type UpdateInput = Partial<Pick<NewBookmarkRow, "title" | "url" | "icon" | "note" | "orderNo">>;

/** Repository for external-app bookmark CRUD operations. */
export class BookmarkStore {
  static async findAll(): Promise<BookmarkRow[]> {
    return db
      .select()
      .from(bookmarks)
      .orderBy(asc(bookmarks.orderNo), asc(bookmarks.createdAt));
  }

  static async findById(id: number): Promise<BookmarkRow | null> {
    const rows = await db.select().from(bookmarks).where(eq(bookmarks.id, id)).limit(1);
    return rows[0] ?? null;
  }

  static async create(data: CreateInput): Promise<BookmarkRow> {
    const rows = await db.insert(bookmarks).values(data).returning();
    const row = rows[0];
    if (!row) throw new Error("Failed to create bookmark");
    return row;
  }

  static async update(id: number, data: UpdateInput): Promise<BookmarkRow | null> {
    const rows = await db
      .update(bookmarks)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(bookmarks.id, id))
      .returning();
    return rows[0] ?? null;
  }

  static async delete(id: number): Promise<boolean> {
    const rows = await db.delete(bookmarks).where(eq(bookmarks.id, id)).returning();
    return rows.length > 0;
  }
}
