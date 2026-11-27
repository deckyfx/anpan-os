import { count, eq } from "drizzle-orm";
import { db } from "../db/index";
import { apiKeys, sessions, users } from "../db/schema";
import type { User } from "../db/schema";

export class UserStore {
  /** Returns the number of users in the database. */
  static async count(): Promise<number> {
    const result = await db.select({ count: count() }).from(users);
    return result[0]?.count ?? 0;
  }

  /** Create a new user, hashing the password with Bun's built-in bcrypt. */
  static async create(username: string, password: string): Promise<User> {
    const passwordHash = await Bun.password.hash(password);
    const result = await db.insert(users).values({ username, passwordHash }).returning();
    const user = result[0];
    if (!user) throw new Error("Failed to create user");
    return user;
  }

  static async findById(id: number): Promise<User | null> {
    const result = await db.select().from(users).where(eq(users.id, id)).limit(1);
    return result[0] ?? null;
  }

  static async findByUsername(username: string): Promise<User | null> {
    const result = await db.select().from(users).where(eq(users.username, username)).limit(1);
    return result[0] ?? null;
  }

  /** Verify a plaintext password against the stored bcrypt hash. */
  static async verifyPassword(user: User, password: string): Promise<boolean> {
    return Bun.password.verify(password, user.passwordHash);
  }

  /** Update the password hash for an existing user and increment token version to invalidate existing JWTs. */
  static async updatePassword(id: number, passwordHash: string): Promise<void> {
    const user = await UserStore.findById(id);
    if (!user) throw new Error("User not found");
    const newTokenVersion = (user.tokenVersion ?? 0) + 1;
    await db.update(users).set({ passwordHash, tokenVersion: newTokenVersion }).where(eq(users.id, id));
  }

  /** Record that `id` now has an avatar of `type`, and return its new version. The bytes live on disk. */
  static async setAvatar(id: number, type: string): Promise<Date> {
    // avatarUpdatedAt is the avatar URL's version and the column holds whole seconds, so two
    // uploads within a second would share a URL and the browser, told the image is immutable,
    // would keep showing the first. Always move it forward by at least a second.
    const current = await UserStore.findById(id);
    const previous = current?.avatarUpdatedAt ? Math.floor(current.avatarUpdatedAt.getTime() / 1000) : 0;
    const at = new Date(Math.max(Math.floor(Date.now() / 1000), previous + 1) * 1000);
    await db.update(users).set({ avatarType: type, avatarUpdatedAt: at }).where(eq(users.id, id));
    return at;
  }

  /**
   * Set a new password and end everything the old one vouched for: every browser session and
   * every API key. Returns the ids of the revoked keys.
   *
   * One synchronous transaction, so the three writes commit or roll back together. Awaited
   * one after another, a failed revocation left the new password saved and the old keys
   * still working, and the owner could not retry, because the old password no longer passed
   * the check. The tokenVersion bump comes first inside it: a key insert racing this change
   * either lands before (and is deleted here) or sees the new version and is refused.
   */
  static changePasswordAndRevoke(id: number, passwordHash: string): string[] {
    return db.transaction(tx => {
      const user = tx.select({ v: users.tokenVersion }).from(users).where(eq(users.id, id)).get();
      if (!user) throw new Error("User not found");
      tx.update(users).set({ passwordHash, tokenVersion: (user.v ?? 0) + 1 }).where(eq(users.id, id)).run();
      tx.delete(sessions).where(eq(sessions.userId, id)).run();
      return tx.delete(apiKeys).where(eq(apiKeys.userId, id)).returning({ id: apiKeys.id }).all().map(r => r.id);
    });
  }

  /** Record that `id` has no avatar. */
  static async clearAvatar(id: number): Promise<void> {
    // avatarUpdatedAt is kept: it is the URL version, and a later upload must still move past
    // it, or a remove and re-upload within a second would reuse the old, cached URL.
    await db.update(users).set({ avatarType: null }).where(eq(users.id, id));
  }

  /** Wipe all users — used by the --reset-user CLI command. */
  static async deleteAll(): Promise<void> {
    await db.delete(users);
  }
}
