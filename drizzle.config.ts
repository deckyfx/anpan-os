import { defineConfig } from "drizzle-kit";

// drizzle-kit runs under Node.js so it reads from .env via process.env.
// TURSO_DATABASE_URL must match RUNTIME_CONFIG_DIR/storage.db for the dev environment.
export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "turso",
  dbCredentials: {
    url: process.env.TURSO_DATABASE_URL!,
  },
});
