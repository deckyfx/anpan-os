import { MigrationManager } from "../db/migration-manager";
import { db } from "../db/index";
import { apiKeys, users } from "../db/schema";
import { removeAllAvatars } from "../lib/avatar";

/** Wipe the users table so a new admin can be created on next start. */
export async function runResetUser(): Promise<never> {
  await MigrationManager.init({ autoMigrate: true });
  // Keys first and by hand: this database runs without `PRAGMA foreign_keys`, so the
  // schema's ON DELETE CASCADE would not remove them, and they would sit there unusable.
  await db.delete(apiKeys);
  await db.delete(users);
  // The only place users are deleted, so the only place their avatar files must go too.
  await removeAllAvatars();
  console.log("✅ Users table wiped. Restart to create a new admin.");
  process.exit(0);
}
