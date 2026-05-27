import { defineConfig } from "drizzle-kit";
import { join } from "node:path";

const configDir = process.env.RUNTIME_CONFIG_DIR ?? "/var/lib/anpan-os";

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "sqlite",
  dbCredentials: {
    url: join(configDir, "storage.db"),
  },
});
