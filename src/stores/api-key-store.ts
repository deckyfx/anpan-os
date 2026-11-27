import { and, count, desc, eq } from "drizzle-orm";
import { db } from "../db/index";
import { apiKeys, users } from "../db/schema";
import type { ApiKey, NewApiKey, User } from "../db/schema";

/** How many keys one user may hold. Enough for every agent anyone runs; few enough to audit. */
export const MAX_API_KEYS_PER_USER = 50;

/** Raised by {@link ApiKeyStore.create} when the password changed during the request. */
export class ApiKeyStaleError extends Error {
  constructor() { super("Your password changed while the key was being created. Sign in again and retry."); }
}

/** Raised by {@link ApiKeyStore.create} when the user already holds the maximum. */
export class ApiKeyLimitError extends Error {
  constructor() {
    super(`At most ${MAX_API_KEYS_PER_USER} API keys per user — delete one first`);
    this.name = "ApiKeyLimitError";
  }
}

/**
 * API-key rows. Hashing, parsing and checking tokens live in lib/api-key-auth; this only
 * reads and writes the table.
 */
export class ApiKeyStore {
  /**
   * Insert a key unless the user is at the limit, or their password changed since
   * `tokenVersion` was read.
   *
   * Count, version check and insert run in one synchronous transaction: awaited separately,
   * two requests sent together could each count 49 and both insert. The version check closes
   * a race with a password change, which bumps tokenVersion and then revokes every key. A
   * create that passed its password check before the change but inserts after the revocation
   * would otherwise leave a working key behind. Inserted before the bump, the revocation
   * removes it; checked after the bump, it is refused here.
   */
  static create(row: NewApiKey, tokenVersion: number): ApiKey {
    return db.transaction(tx => {
      const current = tx.select({ v: users.tokenVersion }).from(users).where(eq(users.id, row.userId)).get();
      if (!current || current.v !== tokenVersion) throw new ApiKeyStaleError();
      const held = tx.select({ n: count() }).from(apiKeys).where(eq(apiKeys.userId, row.userId)).get();
      if ((held?.n ?? 0) >= MAX_API_KEYS_PER_USER) throw new ApiKeyLimitError();
      const created = tx.insert(apiKeys).values(row).returning().get();
      if (!created) throw new Error("Failed to create API key");
      return created;
    });
  }

  /** A user's keys, newest first. */
  static async listFor(userId: number): Promise<ApiKey[]> {
    return db.select().from(apiKeys).where(eq(apiKeys.userId, userId)).orderBy(desc(apiKeys.createdAt));
  }

  /**
   * A key together with the user it acts as, or null if either is gone.
   *
   * Joined rather than trusting the foreign key: SQLite enforces ON DELETE CASCADE only with
   * `PRAGMA foreign_keys` on, which this database does not set, so a removed user's keys
   * could outlive them. The join refuses those keys whatever the pragma says.
   */
  static async findWithUser(id: string): Promise<{ key: ApiKey; user: User } | null> {
    const rows = await db.select({ key: apiKeys, user: users }).from(apiKeys)
      .innerJoin(users, eq(users.id, apiKeys.userId))
      .where(eq(apiKeys.id, id)).limit(1);
    return rows[0] ?? null;
  }

  /** Delete one of `userId`'s keys. False when it is not theirs, or does not exist. */
  static async delete(id: string, userId: number): Promise<boolean> {
    const removed = await db.delete(apiKeys)
      .where(and(eq(apiKeys.id, id), eq(apiKeys.userId, userId)))
      .returning({ id: apiKeys.id });
    return removed.length > 0;
  }

  /**
   * Delete every key `userId` holds, returning their ids.
   *
   * Called on a password change, which already ends every browser session: a key created
   * from a stolen session would otherwise outlive the very step that evicts the thief.
   */
  static async revokeAllFor(userId: number): Promise<string[]> {
    const removed = await db.delete(apiKeys).where(eq(apiKeys.userId, userId)).returning({ id: apiKeys.id });
    return removed.map(r => r.id);
  }

  /** Record a use. Called at most once a minute per key — see lib/api-key-auth. */
  static async touch(id: string, at: Date, ip: string | null): Promise<void> {
    await db.update(apiKeys).set({ lastUsedAt: at, lastUsedIp: ip }).where(eq(apiKeys.id, id));
  }

  /** Move a key's expiry. Not reachable from the API — keys are replaced, not extended. */
  static async setExpiresAt(id: string, expiresAt: Date | null): Promise<void> {
    await db.update(apiKeys).set({ expiresAt }).where(eq(apiKeys.id, id));
  }
}
