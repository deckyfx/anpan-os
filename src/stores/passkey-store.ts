import { eq, and } from "drizzle-orm";
import { db } from "../db/index";
import { passkeys } from "../db/schema";
import type { Passkey } from "../db/schema";

export class PasskeyStore {
  static async findByCredentialId(credentialId: string): Promise<Passkey | null> {
    const result = await db.select().from(passkeys).where(eq(passkeys.credentialId, credentialId)).limit(1);
    return result[0] ?? null;
  }

  static async findByUserId(userId: number): Promise<Passkey[]> {
    return db.select().from(passkeys).where(eq(passkeys.userId, userId));
  }

  static async findById(id: number, userId: number): Promise<Passkey | null> {
    const result = await db.select().from(passkeys)
      .where(and(eq(passkeys.id, id), eq(passkeys.userId, userId)))
      .limit(1);
    return result[0] ?? null;
  }

  static async create(data: {
    userId:       number;
    credentialId: string;
    publicKey:    string;
    counter:      number;
    rpId:         string;
    deviceName?:  string;
  }): Promise<Passkey> {
    const result = await db.insert(passkeys).values(data).returning();
    const pk = result[0];
    if (!pk) throw new Error("Failed to create passkey");
    return pk;
  }

  /** Update counter and last-used timestamp after successful authentication. */
  static async updateCounter(id: number, counter: number): Promise<void> {
    const result = await db.update(passkeys)
      .set({ counter, lastUsedAt: new Date() })
      .where(eq(passkeys.id, id))
      .returning({ id: passkeys.id });
    if (result.length === 0) throw new Error(`Passkey ${id} not found — cannot update counter`);
  }

  static async delete(id: number, userId: number): Promise<boolean> {
    const result = await db.delete(passkeys)
      .where(and(eq(passkeys.id, id), eq(passkeys.userId, userId)))
      .returning();
    return result.length > 0;
  }
}
