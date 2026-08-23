import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { config } from "../config";

const sqlite = new Database(config.databasePath);
// Wait for a competing writer rather than failing instantly. Without this, a second
// process starting while the first is migrating dies here at import time — setting WAL
// needs an exclusive lock, and this module is loaded long before any migration guard runs.
sqlite.run("PRAGMA busy_timeout = 15000;");
sqlite.run("PRAGMA journal_mode = WAL;");

export const db = drizzle(sqlite);
