import { count, eq } from "drizzle-orm";
import { db } from "../db/index";
import { users } from "../db/schema";
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

  static async findByUsername(username: string): Promise<User | null> {
    const result = await db.select().from(users).where(eq(users.username, username)).limit(1);
    return result[0] ?? null;
  }

  /** Verify a plaintext password against the stored bcrypt hash. */
  static async verifyPassword(user: User, password: string): Promise<boolean> {
    return Bun.password.verify(password, user.passwordHash);
  }

  /** Wipe all users — used by the --reset-user CLI command. */
  static async deleteAll(): Promise<void> {
    await db.delete(users);
  }
}
