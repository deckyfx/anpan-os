import { db } from "../db";
import { appRepos } from "../db/schema";
import { eq, asc } from "drizzle-orm";
import type { AppRepoRow, NewAppRepoRow } from "../db/schema";

const DEFAULT_REPOS: Pick<NewAppRepoRow, "name" | "url">[] = [
  { name: "CasaOS AppStore",          url: "https://github.com/IceWhaleTech/CasaOS-AppStore" },
  { name: "CasaOS LinuxServer Store", url: "https://github.com/WisdomSky/CasaOS-LinuxServer-AppStore" },
  { name: "BigBearTechWorld",         url: "https://github.com/bigbeartechworld/big-bear-casaos" },
];

/** Repository for App Store repo CRUD and default seeding. */
export class AppRepoStore {
  /** Insert the three default repos if they don't already exist (idempotent). */
  static async seedDefaults(): Promise<void> {
    for (const repo of DEFAULT_REPOS) {
      await db.insert(appRepos).values(repo).onConflictDoNothing();
    }
  }

  static async findAll(): Promise<AppRepoRow[]> {
    return db.select().from(appRepos).orderBy(asc(appRepos.id));
  }

  static async findById(id: number): Promise<AppRepoRow | null> {
    const rows = await db.select().from(appRepos).where(eq(appRepos.id, id)).limit(1);
    return rows[0] ?? null;
  }

  static async create(data: Pick<NewAppRepoRow, "name" | "url">): Promise<AppRepoRow> {
    const rows = await db.insert(appRepos).values(data).returning();
    const row = rows[0];
    if (!row) throw new Error("Failed to create repo");
    return row;
  }

  static async update(id: number, data: Partial<Pick<NewAppRepoRow, "name" | "enabled">>): Promise<AppRepoRow | null> {
    const rows = await db.update(appRepos).set(data).where(eq(appRepos.id, id)).returning();
    return rows[0] ?? null;
  }

  static async delete(id: number): Promise<boolean> {
    const rows = await db.delete(appRepos).where(eq(appRepos.id, id)).returning();
    return rows.length > 0;
  }
}
