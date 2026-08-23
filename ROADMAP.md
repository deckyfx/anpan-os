# Roadmap

## v0.10.0 — 2026-08-23

### Bug fixes
- **A fresh install created no tables at all.** The migrator read its SQL from a `drizzle/` folder beside the working directory. That folder exists in a source checkout and never in a deployment: the binary is a single file in `/usr/local/bin` run with `WorkingDirectory=/var/lib/anpan-os`. Every migration was therefore skipped, and the empty directory was reported as "No migration files found" — indistinguishable from healthy. The first query then failed with `no such table`. Migrations are now imported as text and compiled into the binary, from a manifest generated out of `drizzle/` at build time so it cannot drift from the folder it mirrors. Verified by deleting the `.sql` files and running the binary from an unrelated directory
- **The Docker image update checker reported no updates, and would have been wrong if it had ever finished.** Two independent faults, both measured on a real host. It was *too slow to complete* — `docker manifest inspect --verbose` takes 18–49 s per image, so a 46-image sweep never reached the end before the SSE stream died. And it *compared incomparable digests*, reading a per-platform manifest digest against the index digest Docker records locally; for any multi-arch image those can never be equal, so a completed sweep would have flagged everything as outdated. Replaced with the registry HTTP API — token via `WWW-Authenticate` discovery, then `HEAD` the manifest and read `Docker-Content-Digest`, which is the index digest and therefore comparable. **45 images now take 8 seconds**
- **Image counts disagreed with every other tool.** The summary reported a single figure from `/info` — 192 image records including intermediate layers, against `docker images`' 132 rows and 113 distinct images. Those are *sources*, not categories. The panel now reports `total` split into `active`, `dangling` and `unused`, which sum to the total
- **Closing the tab left copies running.** `/copy` and `/move` now terminate whichever subprocess is in flight (rsync, its `cp` fallback, or `mv`) rather than leaving it going with nothing reading its output

### New features
- **The update checker is a background job.** The sweep used to belong to an HTTP request, so closing the tab cancelled it. It now belongs to the server: results are written to SQLite as each lands, routes only subscribe, and a reload shows real progress. Single-flight with an atomic force-restart; opportunistic scheduling where the dashboard asks on mount and the *server* decides on staleness, so several tabs cannot each trigger work; per-stack checks from the stack tile menu; 20 s per image, a 10-minute run watchdog, and runs left `running` by a killed process marked interrupted on boot
- **Updates menu** — Check all / View report / Cancel, with live `12/45` progress, and a report showing what a bare badge could not: skipped digest-pinned images, registries that refused, and how long each update has been waiting. Stored results can be purged, refused server-side with 409 while a check runs
- **Disk cleanup panel** — reclaimable space by category, with destructive categories held apart from safe ones and the headline total counting only the safe ones. Every prune names its category twice, once to select and once to confirm
- **Bind paths on stack delete** — per-path checkboxes, unchecked by default, refusing shared roots, personal libraries, symlink escapes, and any path that contains or sits inside another stack's data
- **Private registries** reuse `~/.docker/config.json`; credentials travel only to the registry's own host over HTTPS

### Security
Both predate this work — they arrived with the launch-URL code:
- **`javascript:` URLs could reach the dashboard.** `scheme` was taken verbatim from stack metadata, which is user-editable and also populated by CasaOS imports, and the result is used as an anchor `href`. Restricted to http/https
- **Addresses could smuggle a different host.** `good.com@evil.com` built `http://good.com@evil.com/`, which browsers resolve to **evil.com** — a tile that looks trusted and navigates elsewhere. Authorities containing `@ / ? #` are now rejected, as are malformed IPv6 literals and out-of-range ports

### Improvements
- **The migrator refuses rather than guessing.** It exits if the binary carries no migrations, if the database has more applied than the build knows about, or if an applied migration does not match the build at its position — compared by both content hash and journal timestamp, since either alone can collide. A journal whose timestamps are not strictly increasing is rejected at generation *and* before migrating, because Drizzle resumes from the newest timestamp and would silently skip an entry
- **Concurrent starts are safe.** Materialise, preflight and migrate are held under one cross-process lock keyed by PID *and* process start time, so a recycled PID cannot deadlock every future start. Reclaiming an abandoned lock is itself serialised, since two waiters agreeing a lock is dead could otherwise delete each other's replacement. `PRAGMA journal_mode = WAL` is retried: it needs exclusive access and SQLite does not run the busy handler for it, so a `busy_timeout` does not cover it and simultaneous first starts died there. Eight processes racing one abandoned lock now give one migrator, 16 applied migrations and no crashes
- Show/hide dotfiles in the file browser
- Toasts moved below the top bar; a raw `alert()` replaced with a proper toast

### Dependencies
- **TypeScript 7.0.2**

### Notes
- Test suite **58 pass / 6 fail → 150 pass / 0 fail**. The six long-standing failures were three different situations: one intentional canary (now `test.failing`), two stale tests written against a `diskUsed`/`diskTotal` API that had moved to per-mount `disks[]`, and three that were **right all along** — compose name validation lived inside an SSE generator, so a rejected name returned `200 OK` with an error event in the body. A browser coped; a script would have read it as success
- `HEAD` is deliberate in the update checker: Docker Hub charges a manifest `GET` against the pull limit but not a `HEAD` — measured, with remaining held at 100 across repeated HEADs and dropping by one on a GET — so a full sweep costs nothing against the quota. The `GET` fallback for registries that reject `HEAD` is counted and surfaced, because that path does cost budget

---

## v0.9.0 — 2026-08-12

### Bug fixes
- **Files with non-ASCII names returned 500** — the download route put the raw filename in `Content-Disposition`, whose value must be printable ASCII, so the response threw before any bytes were sent. Any file whose name was not plain ASCII failed to download *and* failed to preview. The header now carries a sanitised `filename=""` plus RFC 6266 `filename*=UTF-8''…`, so browsers still save under the original name
- **Audio and video could not be seeked** — dragging the scrub bar either restarted playback or did nothing. The route relied on Bun's implicit range handling for file-backed responses, which does not survive this plugin: the response arrived with no `Content-Length` and no `Accept-Ranges`, and a range request was answered `200` with the entire file. A browser treats that as non-seekable. Range is now served explicitly, including suffix (`bytes=-500`) and open-ended (`bytes=100-`) forms, with `416` for an unsatisfiable range and a plain `200` for a malformed one
- **Legacy audio MIME types** — Bun reports `audio/x-flac`, which Firefox will not decode. `x-flac`, `x-wav`, `x-m4a` and `x-aac` are mapped to their registered names
- **Previews were served as attachments** — `Content-Disposition: attachment` asks the browser to save rather than render. Previews now request `inline`; the Download action is unchanged

### New features
- **Show/hide dotfiles in the file browser** — toolbar toggle, remembered across sessions, with the count of hidden entries in its tooltip. Select-all is scoped to visible entries, and hiding drops any selected dotfile, so a selection can never include a file that is not on screen
- **FLAC → MP3 conversion** — single file or a whole album folder, at 320k CBR with `-map_metadata 0` so tags carry over instead of the track arriving untagged. Live progress; folder conversion skips files whose `.mp3` already exists, so an interrupted run resumes rather than repeating work
- **Audio metadata panel** — album art, tags and a technical line (`FLAC · 24-bit · 96 kHz · stereo · 3:34 · lossless`) beneath the preview player
- **ID3 tag editor** — edit title, artist, album, genre, year and track on MP3s. Writes merge into the existing tag, so embedded artwork and frames the form does not expose survive an edit
- **Online metadata lookup** — iTunes with a MusicBrainz fallback, **off by default** behind `files.metadata_lookup`. It is the only route that sends user data to a third party, so it stays off until explicitly enabled
- **Copy tags between files** — including artwork; track number is excluded, since it identifies a position within an album

### Security
- **Embedded artwork is no longer served with the MIME declared inside the file.** That value is attacker-controlled — a crafted track can claim `text/html` — and the route is same-origin and cookie-authenticated, so it would have rendered that markup in the app's own origin. Only recognised image types pass through; anything else is served as binary, with `X-Content-Type-Options: nosniff`
- **Fixed a deadlock in SSE streaming** affecting compose operations as well as the new audio ones. `StreamAggregator.push()` checked buffer capacity but not whether the stream had ended, so a producer woken by `end()` while the buffer was full re-queued itself onto a queue nothing would drain again — hanging forever and holding its subprocess and pipes open

### Improvements
- The Docker image update checker no longer appears in the Files page top bar, where it has nothing to act on
- Media previews declare `preload="metadata"`, so a duration and a usable seek bar exist before the first play rather than only after playback starts

### Dependencies
- **TypeScript 7.0.2** — the native compiler. Typechecks the codebase with no changes required; `types: ["bun"]` was already set, which is the notable v6 → v7 break. `typescript` is now consistent across `devDependencies`, `peerDependencies` and `overrides`, which is what actually decides the version `tsc` runs
- lucide-react 1.28.0 → 1.31.0
- **music-metadata** for reading tags (handles FLAC, so a file can be inspected before conversion) and **node-id3** for writing them. `node-taglib-sharp` was rejected despite being more capable: LGPL-2.1 does not sit well with shipping a single statically-bundled executable
- **ffmpeg** is now a registered external tool and appears in System Doctor with an install hint

### Notes
- Open-ended ranges are capped at 8 MB per response. Serving fewer bytes than requested is allowed as long as `Content-Range` describes what was sent, and it keeps `bytes=0-` against a multi-gigabyte video off the heap
- Range responses materialise the requested slice. Handing a lazily sliced `BunFile` to this plugin produced a body that honoured the start offset but streamed to EOF — a `206` contradicting its own `Content-Range`

---

## v0.8.2 — 2026-08-01

### New features
- **Docker summary bar on the dashboard** — a host-wide totals row above the grids: stacks, containers with running/stopped/paused, healthy/unhealthy counts, volumes, images, CPU count and total RAM
- **`GET /api/docker/summary`** — backs the bar from three concurrent daemon calls: the container list (which alone yields stack count, container states and health), `/info` for images/CPU/memory, and the volume list

### Design notes
- The summary bar is deliberately separate from the per-section header counts. Those follow the search filter and describe what is on screen; everything in the bar is a fact about the host and cannot follow a filter — combining them would make both ambiguous
- Container states are read from the container list rather than from `/info`, whose counters are maintained separately and can disagree with the list mid-transition. Sourcing them together keeps every number in the bar describing the same instant
- A failure of `/volumes` or `/info` degrades those fields to zero rather than failing the whole summary, and a 502 keeps the last good values rather than blanking the bar
- Health is only reported by containers declaring a `HEALTHCHECK`, so those counts never sum to the container total; healthy, unhealthy, starting and paused are each shown only when non-zero
- The bar renders nothing until the first poll lands — a row of zeroes on first paint reads as a broken host rather than as "not loaded yet"

### Accessibility
- Summary bar metrics carry screen-reader labels. Several render as a bare number whose meaning comes only from icon colour, which alone announced as "45, 0, 14"; icons are marked decorative so the svg is not announced in place of the label

---

## v0.8.1 — 2026-08-01

### New features
- **Section counts on the dashboard** — headers now read `Docker Stacks (12 running · 3 stopped)` and `External Apps (8 links)`. Counts follow the search filter, so they always describe what is on screen, and `partial` stacks (some services up, some down) are counted separately and shown only when non-zero rather than being misfiled as running or stopped

### Installer
- **Re-running the installer is now a no-op when nothing changed** — the `.sha256` asset is fetched before the binary, so an already-current host transfers ~85 bytes instead of ~95 MB, and the service is neither stopped nor restarted. Comparing hashes rather than version strings also covers dev builds and hand-copied binaries
- **The systemd unit is written only when its contents differ**, so `daemon-reload` and the restart are skipped on an unchanged install — while a service that was down is still started
- **`--release TAG`** installs a specific release instead of the latest. Installing an older tag is detected as a rollback: it warns that config and database are not downgraded, and confirms with a default of *no*
- **`--list`** shows available releases with dates, marking which is latest and which is installed. Runs without root
- **`--yes` / `--force`** for automation and forced reinstalls
- **Shows the installed version, the target version, and the release notes** before doing anything, condensed to a single status line such as `Update: v0.7.0 → v0.8.0`
- Fixed the installed-version parse: the binary prints a `Run mode` banner before the version line, which the old field-based parse reported as `Run`

### Documentation
- README documents the installer options and the rollback caveat, and gains a CLI section — `--doctor`, `--compose-doctor`, `--compose-repair` and `--reset-user` were previously undocumented

---

## v0.8.0 — 2026-08-01

### Bug fixes
- **CasaOS migration left containers bound to the old compose file** — migration ran plain `docker compose up -d`, which only recreates containers whose service definition changed. Containers that happened to be identical kept the labels of the CasaOS file, so a migrated stack stayed split across two compose sources and, once the CasaOS file was deleted, pointed at a path that no longer existed. Migration now deploys with `--force-recreate`
- **Ordinary deploys can now heal the same drift** — `docker compose up` gains `--force-recreate` automatically when a stack's containers are found to come from a compose file other than the managed one. Stacks with no drift still restart only the services that actually changed

### New features
- **Compose source doctor** — reports, per stack, which compose file each container was actually created from, flagging containers anchored to a foreign or deleted path
- **Compose repair** — re-anchors a stack onto the managed compose folder by recreating its containers; adopts a stray compose file into the managed folder when the managed copy is missing. Volumes and networks are preserved; containers restart
- **Orphan guard on repair *and* migration** — both refuse to run when `--remove-orphans` would delete a running service that the compose file does not define, naming the services that must be merged first
- **Split stacks are never partially adopted** — when a stack's containers come from two or more compose files, adoption refuses and lists every path instead of copying one arbitrary file into the managed folder as if it described the whole stack
- **External stacks require explicit intent** — repairing a stack wholly owned by another tool would take it over and restart every container, so it now needs `?adopt=1` rather than being reachable by stack name alone
- **Doctor dialog "Compose paths" check** — new row in System Doctor; opens a Compose Sources dialog listing drifted stacks, their containers, and the offending paths, with repair available per stack
- **`GET /api/compose/compose-sources`** and **`POST /api/compose/stacks/:name/repair`** (SSE log stream) back the dialog
- **CLI: `--compose-doctor`** (add `--all` to include healthy stacks) and **`--compose-repair <stack…> | --all`** for the same workflow from a terminal

### Robustness
- Compose paths are compared in canonical form — a symlinked or non-canonical compose folder no longer reports every healthy stack as drifted and force-recreates on every deploy
- Repair and migration kill the `docker compose` subprocess when the client disconnects; previously the stream producers suspended forever once the buffer filled, leaking the subprocess, its pipes and the log writer for the lifetime of the server
- Compose Sources dialog ignores out-of-order responses, so a slow earlier scan can no longer overwrite a newer one
- A full scan checks each distinct compose path once instead of spawning a `sudo -n test -f` per container

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
