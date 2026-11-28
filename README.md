# anpan-os

A lightweight self-hosted home server dashboard built with **Bun**, **ElysiaJS**, and **React**.

Manage Docker Compose stacks, browse files, monitor system resources, and install apps from community stores — all from a single web UI with no external dependencies beyond Docker and Bun.

---

## Screenshots

| Dashboard | File Manager |
|-----------|-------------|
| ![Dashboard](screenshoots/showcase01.png) | ![File Manager](screenshoots/showcase02.png) |

| New Stack | Stack Actions |
|-----------|--------------|
| ![New Stack](screenshoots/showcase03.png) | ![Stack Actions](screenshoots/showcase04.png) |

---

## Features

### Docker & Stacks
- **Compose dashboard** — install, start, stop, restart, and delete stacks
- **Guided Compose Editor** — Monaco-based YAML editor with syntax highlighting, starter templates, and in-place editing
- **Installs that finish without you** — installs, deploys, updates and migrations run as server jobs: close the tab and they carry on, and the **Jobs** menu in the top bar shows them and their logs again
- **Checked before it starts** — the compose file, `.env` and tile settings are saved before the first start; a port another app or container already uses stops the install before anything runs; a failed install removes its stack folder, its containers, the empty data folders it made and its record (named volumes stay); if Docker cannot remove the containers, the folder and record are kept so that deleting the stack from the dashboard cleans up
- **Live container logs** — per-tab streaming log viewer for running containers
- **Pull & update** — one-click image pull and stack redeploy, or update every outdated stack in one job
- **Compose source doctor** — reports which compose file each container was actually created from, flagging stacks left anchored to a foreign or deleted path
- **Compose repair** — re-anchors a drifted stack onto the managed compose folder, refusing when doing so would delete a running service the compose file does not define

### Backups
- **Back up now** — the system (settings, your account, API keys, every app's tile settings) and each app's stack folder and its data under the data root, into one folder per backup in `[backups] folder` (by default `<runtime dir>/backups`; a mounted drive or share works). When two apps use one folder under the data root, each takes only its own folders in it, so restoring one never touches the other's data. Media libraries and other folders an app mounts from outside the data root, and named Docker volumes, are not included, and the backup's log names them
- **Consistent copies** — an app is stopped while its data is copied and started again after; switch on **Copy while running** per app to keep it up instead, at the risk that a database written during the copy does not restore
- **Restore** — pick the system and any apps from a backup. Each app is stopped and its folders are replaced by the backup's; what was there is kept until the restore succeeds and put back if it fails. The system part is staged and applied when anpan-os restarts (**Restart now** on the Backups page)
- **Download and upload** — download a backup as one `.tar` to keep it elsewhere, and upload one (from this machine or another) to restore from it. App data goes back under the same data root it was taken from

### App Store
- **Browse remote apps** — search and install apps from any CasaOS-compatible GitHub repository. `$AppID`, `$PUID`, `$PGID` and `$TZ` are filled in, and `/DATA/AppData` volumes go to your configured data folder
- **Repo manager** — add, enable/disable, and refresh multiple app sources
- **External bookmarks** — pin arbitrary web app links on the dashboard alongside managed stacks

### File Manager
- Browse, upload, download, rename, and delete files on the host
- Copy / cut / paste across directories
- File info panel with metadata and recursive folder size
- Guided `chmod` / `chown` UI with human-readable permission display

### System & Security
- **System monitor** — CPU, memory, disk, and network stats in the sidebar
- **Port scanner** — scan host ports to identify listening services
- **Samba management** — add, edit, and remove Samba shares; SQLite-backed source of truth
- **WebAuthn passkeys** — register and authenticate with platform authenticators
- **Auth** — JWT session login; bcrypt password storage; in-app password change
- **Account page** — avatar, password, passkey, Docker Hub sign-in and API keys in one place, opened from your name in the top bar
- **API keys** — scoped Bearer tokens so scripts and AI agents can manage stacks through anpan-os, with an OpenAPI description of every route. See [API access](#api-access)
- **HTTPS** — optional TLS via cert/key paths in config
- **Doctor dialog** — dependency checker for required system binaries

### Developer
- **Type-safe API** — Eden Treaty client with full end-to-end type inference
- **CasaOS compatible** — reads `x-casaos` metadata from existing app definitions

---

## Requirements

- [Bun](https://bun.sh) ≥ 1.4.3 — only to build from source (`install-local.sh`, `bun run build`), whose type check is `bun check`. The release binaries carry their own runtime and need no Bun.
- Docker with the Compose plugin (`docker compose`)
- **Must run as root (`sudo`)** — required for Docker management, full filesystem access, and CasaOS migration
- Linux (systemd) or macOS 11+ (launchd), on x86-64 or arm64 — including Apple Silicon

---

## Platform support

anpan-os runs as a root service on Linux and macOS. Most features are identical; the
differences below are the ones where the two systems genuinely diverge.

| Feature | Linux | macOS |
| --- | --- | --- |
| Docker / Compose stacks | ✅ Docker Engine | ✅ Docker Desktop, OrbStack, Colima or Rancher Desktop — the socket is discovered, not assumed |
| File manager, ports, system stats | ✅ | ✅ |
| Reboot / shutdown | ✅ `systemctl` | ✅ `shutdown` |
| Self-update | ✅ | ✅ |
| Samba shares | ✅ | ⚠️ Requires `brew install samba` — see below |
| CasaOS migration | ✅ | ❌ Hidden — CasaOS does not run on macOS |

**About Samba on macOS.** macOS ships `/usr/sbin/smbd`, but it is Apple's own SMB server,
not Samba: it does not read `smb.conf`, and its shares are defined in System Settings →
General → Sharing. anpan-os manages shares by writing a config file and including it from
`smb.conf`, which only works with real Samba. Rather than accepting shares that would
silently never appear, anpan-os detects which server is present and says so. Install Samba
with `brew install samba` to manage shares from anpan-os, or use System Settings to manage
them natively.

**Port 5000 and AirPlay.** macOS runs AirPlay Receiver by default on Apple Silicon, and it
holds ports **5000 and 7000** through Control Center. Its port cannot be changed. The
installer therefore probes 5000 before writing the config: where it is free — the normal
case on Linux — nothing changes, and where it is not, the next free port is used and the
reason is recorded both in the installer output and as a comment in `config.toml`. If every
preferred port is taken the search widens rather than guessing; if nothing at all is free
the install stops instead of writing a port it knows cannot bind. To use
5000 on a Mac, turn AirPlay Receiver off in System Settings → General → AirDrop & Handoff
and edit the port back.

**Docker socket discovery.** The daemon runs as root, while every macOS Docker runtime puts
its socket in a user's home directory. anpan-os finds it — root can connect to a socket it
does not own — and points the `docker` CLI at the same one via `DOCKER_HOST`, so no Docker
Desktop setting needs changing.

---

## Install

> ⚠️ **anpan-os must run as root.**
> Without root, Docker socket access, the file manager, and CasaOS migration are either limited or unavailable.

### One-liner (Linux and macOS)

Downloads the release binary for your OS and architecture, verifies the SHA256 checksum, creates a default config, installs a service, and starts it — all in one step:

```bash
curl -fsSL https://raw.githubusercontent.com/deckyfx/anpan-os/main/install.sh | sudo bash
```

The script detects the platform and installs the matching service:

| | Linux | macOS |
| --- | --- | --- |
| Service | systemd unit at `/etc/systemd/system/anpan-os.service` | LaunchDaemon at `/Library/LaunchDaemons/io.anpan.anpan-os.plist` |
| Config | `/var/lib/anpan-os/config.toml` | `/usr/local/var/anpan-os/config.toml` |
| Binary | `/usr/local/bin/anpan-os` | `/usr/local/bin/anpan-os` |
| Logs | `journalctl -u anpan-os -f` | `tail -f /usr/local/var/anpan-os/anpan-os.log` |

If you prefer not to pipe to `sudo bash`, see [Manual download](#manual-download) below.

**The same command updates an existing install**, and re-running it is cheap: the checksum is fetched before the binary, so a host that is already current downloads nothing and the service is never restarted.

Options go after `bash -s --`:

```bash
# See what's available (no root needed)
curl -fsSL .../install.sh | bash -s -- --list

# Install or roll back to a specific release
curl -fsSL .../install.sh | sudo bash -s -- --release v0.7.0

# Never prompt (CI, automation)
curl -fsSL .../install.sh | sudo bash -s -- --yes
```

| Option | Effect |
| --- | --- |
| `-l, --list` | List available releases and exit. Does not require root. |
| `-r, --release TAG` | Install a specific release instead of the latest. Going backwards is treated as a rollback: it warns and asks for explicit confirmation. |
| `-y, --yes` | Never prompt. Implied automatically when no terminal is available. |
| `-f, --force` | Reinstall even when the installed binary is already identical. |

> ⚠️ **On rollback:** the config file and database are not downgraded, so an older binary may not understand state a newer one wrote.

After the script completes:

```bash
# Linux
systemctl status anpan-os
journalctl -u anpan-os -f

# macOS
sudo launchctl print system/io.anpan.anpan-os
tail -f /usr/local/var/anpan-os/anpan-os.log
```

Open `http://<your-server-ip>:5000` and complete the setup wizard on first run.

### Manual download

```bash
# Detect OS and architecture.
# macOS reports "arm64" where Linux reports "aarch64" — both mean the same binary.
case "$(uname -s)" in Linux) OS=linux ;; Darwin) OS=darwin ;; esac
case "$(uname -m)" in x86_64|amd64) ARCH=x64 ;; aarch64|arm64) ARCH=arm64 ;; esac

# Download binary + checksum.
# Keep the published asset name: the .sha256 file names that file, so renaming it
# on download makes verification fail to find it.
ASSET="anpan-os-${OS}-${ARCH}"
BASE="https://github.com/deckyfx/anpan-os/releases/latest/download"
curl -fsSL "${BASE}/${ASSET}"        -o "${ASSET}"
curl -fsSL "${BASE}/${ASSET}.sha256" -o "${ASSET}.sha256"

# Verify, and stop if it fails — macOS has no sha256sum
if [ "$OS" = darwin ]; then
  shasum -a 256 -c "${ASSET}.sha256" || exit 1
else
  sha256sum -c "${ASSET}.sha256" || exit 1
fi

# Install
chmod +x "${ASSET}"
sudo mv "${ASSET}" /usr/local/bin/anpan-os

# macOS only: strip the Gatekeeper quarantine flag curl set, or the binary
# is killed on launch with no useful message.
[ "$OS" = darwin ] && sudo xattr -d com.apple.quarantine /usr/local/bin/anpan-os 2>/dev/null

# Run
sudo anpan-os
```

### Systemd service (manual setup)

```bash
sudo tee /etc/systemd/system/anpan-os.service > /dev/null <<'EOF'
[Unit]
Description=anpan-os Home Server OS
After=network-online.target docker.service
Wants=network-online.target
Requires=docker.service

[Service]
Type=simple
WorkingDirectory=/var/lib/anpan-os
ExecStart=/usr/local/bin/anpan-os
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now anpan-os
```

### Upgrading

Each of these installs the latest release over the existing binary, after verifying its SHA-256 checksum, and restarts the service. The config file and database are kept; any database migrations run on the next start.

**From the terminal** (v0.13.1 and later):

```bash
anpan-os --upgrade --check   # is a newer release out? (no root needed)
sudo anpan-os --upgrade      # download, verify, install, restart
```

**From the web UI:** open the version dialog and choose **Update now**.

**With the install script:** re-run the [one-liner](#one-liner-linux-and-macos). It also does what the other two cannot: install a specific release with `--release`, or roll back to an older one.

Notes:

- `--upgrade` replaces the binary it was started from, wherever that is, so it needs write access there. That is why it needs `sudo` for `/usr/local/bin/anpan-os`. It checks this before downloading anything.
- Only one update runs at a time. If a terminal upgrade and a web update overlap, the second one is refused and nothing is downloaded.
- If the service does not come back after an upgrade, restart it yourself: the new binary is already in place.

  ```bash
  sudo systemctl restart anpan-os                               # Linux
  sudo launchctl kickstart -k system/io.anpan.anpan-os          # macOS
  ```

- v0.13.0 and earlier have no `--upgrade`. Upgrade those through the web UI or the install script; from then on, `--upgrade` works.

---

## Getting Started (development)

```bash
# Clone
git clone git@github.com:deckyfx/anpan-os.git
cd anpan-os

# Install dependencies
bun install

# Run database migrations
sudo bun run migrate

# Start (development, with hot reload)
sudo bun run dev
```

Open `http://localhost:3000` and complete the setup wizard on first run.

> Running as root ensures all features work in development the same way they do in production.

---

## CLI

Running `anpan-os` with no arguments starts the server. These flags run a single task and exit. Any other argument is an error, so a mistyped command never starts a second server:

| Flag | Purpose |
| --- | --- |
| `--upgrade [--check]` | Install the latest release and restart the service. With `--check`, only report whether one is available. See [Upgrading](#upgrading) |
| `--doctor` | Check required system binaries and report what is missing |
| `--compose-doctor [--all]` | Report which compose file each stack's containers were created from. Exits non-zero when any stack needs repair, so it can gate a deploy script. `--all` lists healthy stacks too |
| `--compose-repair <stack…>`<br>`--compose-repair --all` | Re-anchor stacks onto the managed compose folder. Containers are recreated; named volumes and networks are kept |
| `--reset-user` | Wipe the users table, so the setup wizard runs again on next start |
| `-v, --version` | Print version |
| `-h, --help` | Show help |

**Why compose drift happens:** `docker compose up -d` only recreates containers whose service definition changed. Untouched containers keep the labels of whichever compose file created them, so moving a stack can leave part of it anchored to the old path — and once that file is deleted, those containers reference something that no longer exists. `--compose-doctor` finds them; `--compose-repair` fixes them.

```bash
sudo anpan-os --compose-doctor          # what drifted?
sudo anpan-os --compose-repair mystack  # fix one stack
```

Repair refuses rather than destroys: if the managed compose file does not define a service that is currently running, it names that service and stops, so you can merge the files by hand first.

---

## API access

Scripts and AI agents can call the same API the web UI uses. Going through anpan-os rather than running `docker compose` by hand keeps its records (stack metadata, update results, the managed compose folder) in step with what is actually running.

**Create a key:** **Account → API keys** (click your name in the top bar). Pick a scope and an expiry, confirm with your current password, and copy the token. It is shown once. Then:

```bash
export ANPAN_API_KEY="anpan_…"
curl -H "Authorization: Bearer $ANPAN_API_KEY" https://anpan.local:5000/api/docker/stacks
curl -H "Authorization: Bearer $ANPAN_API_KEY" https://anpan.local:5000/api/openapi.json   # every route, for agents
```

| Scope | Allows |
| --- | --- |
| `read` | GET requests, except files |
| `operate` | `read`, plus creating, starting, stopping and updating stacks and containers (and cancelling those jobs), the update check, App Store, bookmarks and port notes. Not deleting a stack (it removes volumes), prune, files, Samba or shutdown |
| `full` | Everything the web UI can do, except account settings, backups and managing API keys |

A request outside the key's scope gets **403**; a wrong, revoked or expired key gets **401**. The rules (`src/lib/api-key-scope.ts`) are prefix and method grants, checked in order. A new route under an existing prefix inherits that prefix's grant for the methods it lists, so a new `GET /api/docker/…` is readable with a `read` key. A request that matches no grant, such as anything under a new prefix, needs `full`.

Things to know:

- **Treat any `operate` or `full` key like a root password.** A key that can deploy a compose file can mount any host path into a container.
- **Keys cannot manage keys, change the password, or touch the avatar.** Those routes accept only a signed-in browser.
- **Changing your password revokes every API key**, the same way it signs out every browser.
- Each key shows when and from which address it was last used. Every write made with a key is logged as `[api-key] <name> (<id>) <METHOD> <path>` in the service log (`journalctl -u anpan-os`).
- **Installs, deploys, updates, repairs and CasaOS migrations start a job** and answer `202` with it (`409` with the job in the way when that stack is busy). Follow it with `GET /api/jobs/<id>` (status and log so far) or the event stream `GET /api/jobs/stream` (`curl -N`); stop it with `POST /api/jobs/<id>/cancel`. Container logs still stream as Server-Sent Events.

---

## Configuration

On first run, a config file is created at `/var/lib/anpan-os/config.toml`:

```toml
[server]
port = 3000
bind = "local"   # "local" = 127.0.0.1 | "public" = 0.0.0.0
# tls_cert = "/path/to/cert.pem"
# tls_key  = "/path/to/key.pem"

[compose]
# folder = "/custom/path/composes"   # defaults to /var/lib/anpan-os/composes

[apps]
# data_root = "/DATA/AppData"   # one data folder per app; defaults to /var/lib/anpan-os/appdata
# puid = 1000                   # $PUID / $PGID / $TZ for apps that ask for them (CasaOS-style)
# pgid = 1000
# tz = "Europe/Berlin"          # defaults to this machine's time zone

[files]
root = "/"   # root path the file manager can browse
```

All runtime data (config, database, compose files) lives under `/var/lib/anpan-os/` by default — easy to back up or relocate.

---

## Scripts

| Command | Description |
|---|---|
| `bun run dev` | Start with hot reload |
| `bun run migrate` | Apply pending database migrations |
| `bun run db:generate` | Generate a new migration from schema changes |
| `bun run typecheck` | TypeScript type check (zero errors enforced) |
| `bun run test` | Run test suite |

---

## Project Structure

```
src/
├── app.ts                  # ElysiaJS app factory
├── config.ts               # TOML config loader
├── db/                     # Drizzle ORM schema + migrations
├── lib/                    # Docker client, CasaOS parser, commands
├── plugins/                # Route plugins (auth, docker, compose, files, app-store…)
├── stores/                 # DB repository classes
└── public/
    └── app/
        ├── components/     # Shared UI components
        ├── lib/            # Eden Treaty API client
        ├── pages/          # React page components
        └── stores/         # Zustand client stores
```

---

## Changelog

See [ROADMAP.md](ROADMAP.md) for a full list of changes per release.

---

## License

MIT — see [LICENSE](LICENSE).
