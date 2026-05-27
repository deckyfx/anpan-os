import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { config } from "../config";

const sqlite = new Database(config.databasePath);
sqlite.exec("PRAGMA journal_mode = WAL;");

export const db = drizzle(sqlite);
