import { sqliteTable, integer, text, primaryKey } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  tokenVersion: integer("token_version").notNull().default(0),
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
  /** Custom host/address for the web UI (e.g. "npm.home.lan"). Blank = use current browser host. */
  address:     text("address"),
  /** Freeform markdown/text note for this stack. */
  note:        text("note"),
  /** How the web UI is opened: "new-page" (_blank), "here" (_self), "contained" (in-app dialog). */
  openMode:    text("open_mode"),
  /** true = installed via this app or imported from CasaOS; false = discovered from Docker only. */
  managed:     integer("managed", { mode: "boolean" }).notNull().default(false),
  /** User-defined display order (null = unset, sorted last). */
  orderNo:     integer("order_no"),
  updatedAt:   integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

/**
 * WebAuthn / Passkey credentials bound to a user.
 * rpId is stored per-credential so registrations from different hostnames
 * (e.g. anpan.home.lan vs 192.168.1.x) coexist without conflict.
 */
export const passkeys = sqliteTable("passkeys", {
  id:           integer("id").primaryKey({ autoIncrement: true }),
  userId:       integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  credentialId: text("credential_id").notNull().unique(),
  publicKey:    text("public_key").notNull(),
  counter:      integer("counter").notNull().default(0),
  rpId:         text("rp_id").notNull(),
  deviceName:   text("device_name"),
  createdAt:    integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  lastUsedAt:   integer("last_used_at", { mode: "timestamp" }),
});

export type User    = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

export type Stack    = typeof stacks.$inferSelect;
export type NewStack = typeof stacks.$inferInsert;

export type Passkey    = typeof passkeys.$inferSelect;
export type NewPasskey = typeof passkeys.$inferInsert;

/**
 * Samba shares managed by anpan-os.
 * This is the source of truth — the flat-file samba.conf is regenerated from this table.
 */
export const sambaShares = sqliteTable("samba_shares", {
  id:         integer("id").primaryKey({ autoIncrement: true }),
  name:       text("name").notNull().unique(),
  path:       text("path").notNull(),
  comment:    text("comment").notNull().default(""),
  readOnly:   integer("read_only", { mode: "boolean" }).notNull().default(false),
  browseable: integer("browseable", { mode: "boolean" }).notNull().default(true),
  guestOk:    integer("guest_ok",   { mode: "boolean" }).notNull().default(true),
  createdAt:  integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

export type SambaShareRow    = typeof sambaShares.$inferSelect;
export type NewSambaShareRow = typeof sambaShares.$inferInsert;

/**
 * External app bookmarks — user-curated links to external websites/services.
 * Supports a freeform note per bookmark (e.g. credentials, usage hints).
 */
export const bookmarks = sqliteTable("bookmarks", {
  id:        integer("id").primaryKey({ autoIncrement: true }),
  title:     text("title").notNull(),
  url:       text("url").notNull(),
  /** Optional icon URL. Falls back to favicon.ico at the bookmark's origin. */
  icon:      text("icon"),
  /** Freeform markdown/text note (e.g. credentials, hints). */
  note:      text("note"),
  /** User-defined display order (null = unset, sorted last). */
  orderNo:   integer("order_no"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

export type BookmarkRow    = typeof bookmarks.$inferSelect;
export type NewBookmarkRow = typeof bookmarks.$inferInsert;

/**
 * App Store repositories — user-managed list of CasaOS-compatible GitHub repos.
 * The three default repos are seeded on first run via AppRepoStore.seedDefaults().
 */
export const appRepos = sqliteTable("app_repos", {
  id:        integer("id").primaryKey({ autoIncrement: true }),
  name:      text("name").notNull(),
  url:       text("url").notNull().unique(),
  enabled:   integer("enabled", { mode: "boolean" }).notNull().default(true),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

export type AppRepoRow    = typeof appRepos.$inferSelect;
export type NewAppRepoRow = typeof appRepos.$inferInsert;

/**
 * One row per image-update sweep.
 *
 * Only a summary is kept — the per-image outcome lives in {@link imageUpdateState}, which
 * holds current state rather than history. Old runs are pruned to a small number, since
 * nothing in the product asks a question about a sweep from last month.
 */
export const updateCheckRuns = sqliteTable("update_check_runs", {
  id:         integer("id").primaryKey({ autoIncrement: true }),
  /** running | done | failed | cancelled | interrupted */
  status:     text("status").notNull().default("running"),
  total:      integer("total").notNull().default(0),
  completed:  integer("completed").notNull().default(0),
  updatesFound: integer("updates_found").notNull().default(0),
  /** Manifest GETs used because a registry rejected HEAD — these cost pull budget. */
  getFallbacks: integer("get_fallbacks").notNull().default(0),
  /** Whether the sweep was started automatically on dashboard open, or by the user. */
  auto:       integer("auto", { mode: "boolean" }).notNull().default(false),
  /** Stack this run was limited to, or null for a full sweep. */
  scopeStack: text("scope_stack"),
  error:      text("error"),
  startedAt:  integer("started_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  /** Last time a result was written — lets the UI say "no progress for 6 minutes". */
  progressAt: integer("progress_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  finishedAt: integer("finished_at", { mode: "timestamp" }),
});

export type UpdateCheckRunRow    = typeof updateCheckRuns.$inferSelect;
export type NewUpdateCheckRunRow = typeof updateCheckRuns.$inferInsert;

/**
 * Current update state for one image within one stack.
 *
 * Keyed by (stack, image) and upserted each sweep, so the table stays the size of the
 * user's library rather than growing with every check. `firstSeenAt` carries the one
 * genuinely historical fact worth keeping — how long an update has been waiting — without
 * a history table behind it.
 */
export const imageUpdateState = sqliteTable("image_update_state", {
  stack:        text("stack").notNull(),
  image:        text("image").notNull(),
  localDigest:  text("local_digest"),
  remoteDigest: text("remote_digest"),
  hasUpdate:    integer("has_update", { mode: "boolean" }).notNull().default(false),
  /** Set when the image could not be checked at all (network, auth, unparseable ref). */
  error:        text("error"),
  /** Set when a check is not meaningful — digest-pinned, or never pulled from a registry. */
  skippedReason: text("skipped_reason"),
  /** When hasUpdate first became true for this pair; cleared once the digests agree again. */
  firstSeenAt:  integer("first_seen_at", { mode: "timestamp" }),
  checkedAt:    integer("checked_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  runId:        integer("run_id"),
}, (t) => [primaryKey({ columns: [t.stack, t.image] })]);

export type ImageUpdateStateRow    = typeof imageUpdateState.$inferSelect;
export type NewImageUpdateStateRow = typeof imageUpdateState.$inferInsert;
