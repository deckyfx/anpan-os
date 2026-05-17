# Roadmap

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
