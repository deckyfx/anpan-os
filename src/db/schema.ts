import { sqliteTable, integer, text } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

/** Generic key-value store for app-level settings (JWT secret, etc.). */
export const appSettings = sqliteTable("app_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

/**
 * Persistent metadata for Docker stacks/compose projects.
 * Keyed by compose project name (or container name for standalones).
 * Synced from Docker on every /api/docker/stacks call; enriched manually or via CasaOS import.
 */
export const stacks = sqliteTable("stacks", {
  id:          text("id").primaryKey(),
  title:       text("title"),
  icon:        text("icon"),
  tagline:     text("tagline"),
  portMap:     text("port_map"),
  scheme:      text("scheme").default("http"),
  indexPath:   text("index_path").default("/"),
  mainService: text("main_service"),
  /** Freeform markdown/text note for this stack. */
  note:        text("note"),
  /** true = installed via this app or imported from CasaOS; false = discovered from Docker only. */
  managed:     integer("managed", { mode: "boolean" }).notNull().default(false),
  /** User-defined display order (null = unset, sorted last). */
  orderNo:     integer("order_no"),
  updatedAt:   integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

export type Stack = typeof stacks.$inferSelect;
export type NewStack = typeof stacks.$inferInsert;
