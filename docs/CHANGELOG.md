# Changelog

> Git history preserved before repository reset.

---

## feat: stack metadata DB, CasaOS compatibility, and tile UI enhancements
**Commit:** `0af6d0c`

- Add stacks table (title, icon, tagline, portMap, scheme, indexPath, mainService, note, managed) with three Drizzle migrations
- StackStore with COALESCE upsert — Docker sync never overwrites user edits
- GET /api/docker/stacks syncs stacks to DB and merges metadata into response
- PATCH /api/docker/stacks/:name to edit any metadata field
- CasaOS lib parses tips field; POST /api/casaos/import/:id seeds all metadata (title, icon, tagline, portMap, scheme, index, note) from x-casaos compose block and marks stack as managed
- Wire casaosPlugin into app; compose install marks stacks as managed
- StackTile: icon image with letter fallback, custom title, tagline, launch URL built from meta, Edit Info dialog, Note dialog with dot indicator, Import from CasaOS menu item
- Bulk-imported CasaOS tips into note column for 22 existing stacks

---

## feat: modular CLI args, command registry, and homepage layout redesign
**Commit:** `8850269`

- Rename server.ts → index.ts; extract --doctor and --reset-user into src/cli/doctor.ts and src/cli/reset-user.ts for clean separation
- Add CommandRegistry singleton (src/lib/commands.ts) as single source of truth for all external binaries; wire bins.* into compose, files, samba, and system plugins; replace Bun.$ mkdir with native mkdirSync
- Add --doctor flag: table of required tools with availability, install hints, and TTY-aware ANSI colour output
- Redesign HomePage into four-zone layout: top bar, left widget panel (clock, calendar, resources, network), right apps grid, bottom status bar; enlarge app tiles to 160px grid with bigger icons
- Add /api/system/info endpoint returning app version; embed APP_VERSION via build-time define in build.ts; fix build.ts entry point to index.ts
- Add version display (v0.1.0) and sign-out icon to top bar

---

## test: unit tests for docker, compose, and system routes
**Commit:** `a29cda5`

- docker.test.ts: auth guard (401) + functional tests (200 or 502) covering containers, inspect, start/stop/restart, logs, info
- compose.test.ts: auth guard + name validation (spaces/dots/traversal → 422) + content validation + authenticated operational calls
- system.test.ts: auth guard + stats shape/plausibility (cpu 0-100, ramUsed ≤ ramTotal, diskUsed ≤ diskTotal)
- helpers.ts: add loginAs() to create admin and return session cookie
- routeSystem.ts: suppress df stdout with .quiet()
- 63 pass, 1 intentional fail (prove.test.ts)

---

## feat: docker dashboard, management, compose, files, and samba
**Commit:** `a4ebff8`

- DockerClient: typed wrapper over Docker Unix socket API
- routeDocker: container list/inspect/start/stop/restart/logs endpoints
- routeCompose: stack install/down/restart/logs via docker compose
- routeSystem: CPU/RAM/disk stats from /proc and df
- routeFiles: file browser list/read/write/rename/delete/mkdir/upload/download
- routeSamba: samba share list/add/remove/reload
- HomePage: CasaOS-style grid with Files tile, New Stack tile, container tiles
- FilesPage: full file manager with Samba panel
- Shared UI components: Badge, Panel, Drawer, Dialog, ConfirmDialog, LogViewer
- App router: client-side path routing (/, /files) with useRouter hook
- config.ts: compose folder config field

---

## feat: auth system with JWT sessions, Eden Treaty tests, and React UI
**Commit:** `b285ff5`

- Extract createApp() factory for testability; server.ts composes it with plugins
- Add auth routes: /api/auth/setup, /login, /logout, /status
- Add authGuard plugin protecting /api/me and future guarded routes
- Add UserStore (bcrypt passwords) and SettingsStore (auto-generated JWT secret)
- Add app_settings migration for key-value storage
- Add constants/auth.ts with runtime validators; TypeBox schemas are type contracts only
- Add Eden Treaty unit tests (no running server) with isolated test DB via preload
- Add tests/prove.test.ts demonstrating real logic executes (intentional failure on wrong password)
- Refactor tests/helpers.ts: createTestClient(), extractCookie(), errMsg()
- Add React frontend: setup, login, and dashboard pages with auth state management

---

## feat: runtime config via config.toml
**Commit:** `d97a978`

- Config class reads RUNTIME_CONFIG_DIR/config.toml using Bun.TOML.parse()
- Creates blank template on first run if file missing
- Defaults to $HOME/.anpanos when RUNTIME_CONFIG_DIR is not set
- Loaded at server startup before app initializes

---

## feat: setup Drizzle ORM with Turso/LibSQL
**Commit:** `3b13fef`

- drizzle-orm + @libsql/client + drizzle-kit
- dialect: turso, schema: users table (auth milestone prep)
- MigrationManager with strict/auto-migrate modes
- Local dev: file:./local.db, production: libsql:// + auth token
- drizzle.config.ts uses process.env (drizzle-kit runs under Node)
- Scripts: migrate, db:generate, db:studio

---

## feat: bind 0.0.0.0 with self-signed TLS
**Commit:** `388922e`

- Generate certs via openssl (./certs/, gitignored)
- Dev defaults to ./certs/, production defaults to /etc/anpan-os/
- Configurable via TLS_CERT / TLS_KEY env vars

---

## chore: initial project setup
**Commit:** `db00c2d`

- Bun + ElysiaJS + React + Tailwind fullstack skeleton
- Two-stage build (dist/ assets + linux binaries), dev/binary mode split via RUN_MODE
