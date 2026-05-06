import { eq } from "drizzle-orm";
import { db } from "../db/index";
import { appSettings } from "../db/schema";

export class SettingsStore {
  static async get(key: string): Promise<string | null> {
    const result = await db.select().from(appSettings).where(eq(appSettings.key, key)).limit(1);
    return result[0]?.value ?? null;
  }

  static async set(key: string, value: string): Promise<void> {
    await db
      .insert(appSettings)
      .values({ key, value })
      .onConflictDoUpdate({ target: appSettings.key, set: { value } });
  }

  /** Returns the JWT signing secret, generating and persisting one on first call. */
  static async getOrCreateJwtSecret(): Promise<string> {
    const existing = await this.get("jwt_secret");
    if (existing) return existing;

    const secret = crypto.randomUUID() + "-" + crypto.randomUUID();
    await this.set("jwt_secret", secret);
    return secret;
  }
}
