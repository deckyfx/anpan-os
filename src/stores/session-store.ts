import { and, eq, lt } from "drizzle-orm";
import { db } from "../db/index";
import { sessions } from "../db/schema";

/** How long a session lasts — the same lifetime as the JWT and cookie that carry it. */
export const SESSION_MAX_AGE_S = 7 * 24 * 60 * 60;

/**
 * Signed-in browsers, one row each.
 *
 * A session is live while its row exists and is younger than {@link SESSION_MAX_AGE_S}.
 * Logging out deletes the row, which is what makes a logout reach a token that was copied
 * before it: the JWT still verifies, but the session it names is gone.
 */
export class SessionStore {
  /**
   * Record a new session for `userId` and return its id.
   *
   * Expired rows are pruned here rather than on a timer: logins are infrequent, and this
   * keeps the table bounded by roughly one row per device per week.
   */
  static async create(userId: number): Promise<string> {
    await db.delete(sessions).where(lt(sessions.createdAt, SessionStore.cutoff()));
    const id = crypto.randomUUID();
    await db.insert(sessions).values({ id, userId });
    return id;
  }

  /** Whether `sid` is a live session belonging to `userId`. */
  static async isActive(sid: string, userId: number): Promise<boolean> {
    const rows = await db.select({ createdAt: sessions.createdAt }).from(sessions)
      .where(and(eq(sessions.id, sid), eq(sessions.userId, userId))).limit(1);
    const row = rows[0];
    return !!row && row.createdAt >= SessionStore.cutoff();
  }

  /** End one session — this device's logout. Unknown ids are ignored. */
  static async revoke(sid: string): Promise<void> {
    await db.delete(sessions).where(eq(sessions.id, sid));
  }

  /** End every session of `userId` — used when the password changes. */
  static async revokeAllFor(userId: number): Promise<void> {
    await db.delete(sessions).where(eq(sessions.userId, userId));
  }

  /** Sessions created before this moment have expired. */
  private static cutoff(): Date {
    return new Date(Date.now() - SESSION_MAX_AGE_S * 1000);
  }
}
