import { MigrationManager } from "../db/migration-manager";
import { db } from "../db/index";
import { users } from "../db/schema";

/** Wipe the users table so a new admin can be created on next start. */
export async function runResetUser(): Promise<never> {
  await MigrationManager.init({ autoMigrate: true });
  await db.delete(users);
  console.log("✅ Users table wiped. Restart to create a new admin.");
  process.exit(0);
}
