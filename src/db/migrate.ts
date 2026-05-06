import { MigrationManager } from "./migration-manager";

await MigrationManager.runMigrations().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
