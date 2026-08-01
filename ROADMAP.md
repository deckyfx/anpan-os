# Roadmap

## v0.8.0 — 2026-08-01

### Bug fixes
- **CasaOS migration left containers bound to the old compose file** — migration ran plain `docker compose up -d`, which only recreates containers whose service definition changed. Containers that happened to be identical kept the labels of the CasaOS file, so a migrated stack stayed split across two compose sources and, once the CasaOS file was deleted, pointed at a path that no longer existed. Migration now deploys with `--force-recreate`
- **Ordinary deploys can now heal the same drift** — `docker compose up` gains `--force-recreate` automatically when a stack's containers are found to come from a compose file other than the managed one. Stacks with no drift still restart only the services that actually changed

### New features
- **Compose source doctor** — reports, per stack, which compose file each container was actually created from, flagging containers anchored to a foreign or deleted path
- **Compose repair** — re-anchors a stack onto the managed compose folder by recreating its containers; adopts a stray compose file into the managed folder when the managed copy is missing. Volumes and networks are preserved; containers restart
- **Orphan guard on repair** — repair refuses to run when `--remove-orphans` would delete a running service that the managed compose file does not define, naming the services that must be merged first
- **Doctor dialog "Compose paths" check** — new row in System Doctor; opens a Compose Sources dialog listing drifted stacks, their containers, and the offending paths, with repair available per stack
- **`GET /api/compose/compose-sources`** and **`POST /api/compose/stacks/:name/repair`** (SSE log stream) back the dialog
- **CLI: `--compose-doctor`** (add `--all` to include healthy stacks) and **`--compose-repair <stack…> | --all`** for the same workflow from a terminal

### Tooling
- **`install-local.sh`** — builds the current working tree and installs it over the systemd service, matching the layout `install.sh` produces. For testing changes under a real production run (root, systemd, real Docker socket) instead of `bun run dev`. Supports `--skip-build`, `--no-typecheck`, `--no-follow`; refuses to run as root; verifies the service is actually active afterwards and dumps the journal if not
- **`BUILD_TARGETS` env filter in `build.ts`** — build a single architecture instead of all of them; the clean step now removes only the artifacts being rebuilt, so a filtered build no longer wipes the other architecture's binary

---

## v0.7.0 — 2026-06-12

### New features
- **Docker image update checker** — one-click check of all running and stopped compose containers for available image updates; compares local vs remote digest via `docker manifest inspect`
- **Per-stack update badge** — amber ↑ badge on the stack tile when a newer image is available
- **TopBar "Updates" button** — live spinner while checking; click to cancel; amber count badge opens the updates dialog when results are ready; auto-check runs on dashboard mount
- **Mass update dialog** — select which stacks to update, then pull+redeploy them sequentially; live log stream per stack; shows success/failure summary when done; Cancel button aborts the current pull and clears the remaining queue
- **Update check SSE endpoint** — `GET /api/docker/update-check`; streams `checking`, `result`, and `done` events; cancels any previous check when a new request arrives; surfaces docker errors as SSE error events

### Improvements
- Update checker kills spawned `docker inspect` / `docker manifest inspect` subprocesses immediately on abort — no orphaned processes
- 5-minute per-stack timeout guard in the mass update dialog prevents a hung SSE stream from blocking the queue indefinitely
- `checking` spinner state clears correctly if the SSE stream ends without an explicit `done`/`error` message

---

## v0.6.1 — 2026-06-05

### New features
- **File browser config dialog** — configure the file browser via a new settings dialog (⚙ button in the toolbar):
  - **Custom start path** — set the directory the browser opens to instead of defaulting to root
  - **Persist last visited path** — automatically resume where you left off on the next visit; falls back to start path or home if the saved path becomes inaccessible
  - **Bookmarks** — pin directories for quick access; full management (add, rename, delete) in the config dialog

### Improvements
- **Bookmark chips bar** — scrollable pill row between toolbar and file list; active path highlighted in amber; hover reveals × to remove instantly; gear icon opens config dialog
- **Bookmark star button** — filled star in toolbar when current path is bookmarked (click to remove); outline star opens a name popover to add; popover dismisses on click-outside or Escape
- Bookmark paths and start/last path validated against the allowed file root on save (prevents out-of-root entries persisting in config)
- `updateLastPath` debounced (500ms) to coalesce rapid navigation saves
- Config save rolls back optimistically-applied state and shows an error toast on API failure

---

## v0.6.0 — 2026-06-04

### Fixes
- **Auth broken behind HTTP reverse proxy** — session cookie had the `Secure` attribute set based on whether the backend had TLS enabled, not on whether the *client-facing* connection was HTTPS. When Nginx Proxy Manager (or any other proxy) terminates TLS and forwards plain HTTP to anpan-os, browsers silently discarded the `Secure` cookie — login appeared to succeed but all subsequent XHR returned 401. Fixed in `setSession()` (routeAuth + routePasskey): `Secure` is now derived from `X-Forwarded-Proto`, falling back to `config.tlsEnabled` for direct connections
- **`tokenVersion` null mismatch — all API calls 401 after login** — `requireActiveSession` and `authGuard` compared `payload.tokenVersion` (always `0` for users created before the `tokenVersion` column was added) against `user.tokenVersion` from the DB (which is `null` for those users). `0 !== null` caused every request to fail with 401. Fixed by normalising the DB value with `?? 0` in all three comparison sites (`authGuard.ts`, `routeAuth.ts` × 2)

### New features
- **CLI arguments** — `anpan-os --version` / `-v` prints the version and exits; `anpan-os --help` / `-h` prints usage, lists all flags, and shows the root requirement note
- **`bun run deploy` script** — builds the binary from source and installs it to `/usr/local/bin/anpan-os` then restarts the systemd service; useful for local development without a GitHub release

### Improvements
- CLI argument parsing extracted to `src/cli-parser.ts` (`CliResult` discriminated union + `parseCli()`) — easy to extend with future flags
- `install.sh` shows a download progress bar (`curl --progress-bar`) instead of running silently
- README: root requirement (`sudo`) documented in Requirements section and Install warning; dev commands updated to `sudo bun run dev`; config path corrected to `/var/lib/anpan-os/`

---

## v0.5.1 — 2026-05-28

### New features
- **`disable_login_method` config** — add `disable_login_method = ["form"]` (or `["passkey"]`, or both) to `[auth]` in `config.toml` to selectively block login methods at the API level; blocked endpoints return 403 regardless of input
- **`GET /api/auth/methods`** — new public endpoint returns `{ form: boolean, passkey: boolean }` so the UI knows which login methods are active
- **Login UI adapts to config** — login form hidden when `form` is disabled; passkey button hidden when `passkey` is disabled; "Add passkey" menu item in TopBar hidden when passkey is disabled; PasskeySetupPage auto-skips when passkey is disabled

### Security
- Admins can harden a production instance to passkey-only login (`disable_login_method = ["form"]`) after completing initial setup, eliminating the credential-guessing attack surface on the password endpoint

---

## v0.5.0 — 2026-05-28

### New features
- **Configurable `sameSite` cookie** — add `session_same_site` to `[auth]` in `config.toml` (default `strict`; set `lax` for multi-hostname LAN access where the app is opened from both an IP and a DNS name)
- **App Store TopBar** — App Store page now shows the shared TopBar so users can navigate back to Home without reloading
- **Version badge & VersionDialog** — version number moved to the right side of TopBar as a clickable badge; opens a dialog showing current version, release notes fetched from GitHub, and an update button
- **Self-update endpoint** — `POST /api/system/update` downloads the latest release binary, verifies its SHA256 checksum, replaces the running binary, and restarts the service; `GET /api/system/update-check` returns the current/latest version and whether an update is available
- **SHA256 release artifacts** — CI now generates and uploads `.sha256` checksum files alongside each release binary; `install.sh` verifies the checksum before installing
- **App Store streaming** — apps load progressively as each repository resolves (SSE); the grid populates incrementally instead of waiting for all repos to finish
- **App detail: zoomable screenshots** — screenshot thumbnails open a full lightbox with zoom, pan, and prev/next navigation via viewerjs
- **App detail: Developer & Release section** — shows version, last updated date, collapsible release notes, and link chips (Website, GitHub, Support, Docs) sourced from the compose file's `x-casaos` metadata

### Improvements
- Screenshots section appears above the About text in the app detail dialog

### Fixes
- `updatedAt` YAML date fields (parsed as JavaScript `Date` objects by the YAML library) no longer crash the app detail dialog; rendered as a human-readable locale string

---

## v0.4.1 — 2026-05-27

### Fixes
- **Store page crash** — App Store no longer freezes with "Maximum update depth exceeded"; root cause was Zustand object-literal selectors in `AppDetailDialog` and `RepoManagerDialog` creating new references on every render; fixed with `useShallow`
- **Repo Manager toggle thumb** — switch thumb was rendering outside the track due to missing `left` anchor on the `absolute` span; fixed with explicit `left-0.5`
- **Repo Manager backdrop** — added `disableBackdropClose` to prevent accidental dismissal
- **Dev mode error messages** — `NODE_ENV=development` now enables non-minified React with full error messages; production keeps `development: false` to avoid Bun's file-watcher WebSocket triggering dialog reloads on SQLite WAL writes

---

## v0.4.0 — 2026-05-27

### New features
- **Browse Mounted Volumes** — navigate directly to a stack's host bind-mount path in the file manager; shows a picker dialog when a stack has multiple mounts
- **Batch delete** — select multiple files/folders in the file manager and delete them all at once
- **One-click install script** — `install.sh` for curl-pipe installation on any Linux x64/arm64 machine
- **System-level deployment** — anpan-os now runs as a systemd service under `/usr/local/bin/anpan-os` with config at `/var/lib/anpan-os`
- **Samba: Migrate to AnpanOS** — one-click migration of external (CasaOS-managed) Samba shares into anpan-os management; automatically removes the share block from the source conf file to prevent duplicate `[SectionName]` entries
- **Samba: Guest access toggle** — per-share `guestOk` boolean (default enabled) controls `guest ok = Yes/No` in smb.conf; fixes Windows credential prompt for anpan-os-managed shares
- **Samba: Edit share dialog** — edit comment, read-only, and guest access settings on existing managed shares without recreating them
- **Samba: Comment field in Add Share** — auto-fills as `"AnpanOS share {name}"` and updates as you type the share name; editable before saving

### Improvements
- Binary is now fully self-contained — no `dist/` folder needed alongside the executable; HTML/CSS/JS bundled directly into the binary via Bun's HTML import
- Switched database driver from `@libsql/client` (native addon, incompatible with standalone binary) to `bun:sqlite` (built into Bun runtime)
- Default config directory changed from `$HOME/.anpanos` to `/var/lib/anpan-os` for system-wide installs
- Removed unused `routeAppBinary` static-file plugin
- `disableBackdropClose` on all editing/detail dialogs — Add Share, Edit Share, Chmod, file text editor, Info, Archive, Doctor, Docker Hub, Samba Manager — prevents accidental data loss from mis-clicks

### Fixes
- `Promise.allSettled` in batch delete ensures all items are attempted even if some fail
- File manager `initialize()` always called on mount; pending path cleared via store action instead of direct mutation
- `setPendingPath` accepts `null` to allow clearing the pending navigation path
- Samba share list deduplicated by name — anpan-os-managed shares no longer also appear in the External section
- Symlink-safe include-path comparison via `realpath()` prevents anpan-os's own conf from being parsed as an external share

---

## v0.3.0 — 2026-05-17

### New features
- **Migrate from CasaOS** — one-click migration of CasaOS-managed stacks to anpan-os managed compose files

### Improvements
- Origin badge on stack tiles distinguishes managed vs CasaOS stacks
- Migration dialog streams live progress via SSE

---

## v0.2.0 — 2026-05-17

### New features
- **App Store** — browse and one-click install apps from any CasaOS-compatible GitHub repository; manage multiple repos; search, filter by category and source; auto-resolves default branch, 10 s fetch timeouts, canonical URL deduplication
- **Samba share management** — add, edit, and remove Samba shares with SQLite as the source of truth; always-visible button, disabled when `smbd` is absent
- **Guided Compose Editor** — Monaco-based YAML editor with syntax highlighting, template picker, in-place edit, and live install log streaming
- **Live container logs** — per-tab real-time log streaming for running containers, with abort-on-unmount
- **Port scanner** — dialog to scan host ports and identify listening services
- **External app bookmarks** — new dashboard section to pin arbitrary web app links alongside managed stacks
- **File manager enhancements** — copy / cut / paste, info panel with metadata, recursive folder-size calculation
- **Guided chmod / chown UI** — permission and ownership editor with human-readable mode display
- **WebAuthn passkeys** — register and authenticate with platform authenticators alongside password login
- **Change password** — in-app password change with session refresh
- **Compose templates** — built-in starter templates selectable from the guided editor
- **Pull & update** — one-click image pull and stack redeploy from the stack actions menu
- **TopBar menu** — collapsible navigation with Doctor dialog (binary dependency checker) and disk usage widget

### Improvements
- SSE install/deploy streams cancelled cleanly on component unmount; close blocked during active operations
- Toast notification system for async action feedback across the whole UI
- ARIA roles and labels on interactive components (switches, icon buttons, dismissible banners)
- Eden Treaty async-generator streams replace raw `fetch` SSE in the frontend
- Bounded `StreamAggregator` with backpressure prevents memory growth on large log outputs
- Session token refreshed automatically after password change

### Fixes
- Guard against missing Docker binary; filter leading slash from container names
- Reject stale pre-rotation tokens in Docker Hub handlers
- Normalise trailing slash in file manager Up button path
- `resolveBins` filters unsupported platforms; returns `Partial<Record<ToolId, string>>`
- `withDockerHubAuth` wrapper extracted to eliminate repeated auth guard duplication

---

## v0.1.0 — initial release

- Docker Compose stack dashboard (install, start, stop, restart, delete)
- File manager (browse, upload, download, rename, delete)
- System monitor (CPU, memory, disk, network sidebar widgets)
- CasaOS `x-casaos` metadata reader for installed apps
- JWT session login with bcrypt password storage
- Optional TLS via cert/key config
- Type-safe Eden Treaty API client

---

## Planned / ideas

- Stack resource usage (CPU/mem per container)
- Notification webhooks (Discord, ntfy)
- Multi-user support with role-based access
- App Store rating / community reviews
- Scheduled tasks (cron via UI)
- Backup and restore of compose + config
