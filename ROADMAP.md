# Roadmap

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
