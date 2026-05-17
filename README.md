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
- **Live install logs** — real-time streaming of `docker compose up` output
- **Live container logs** — per-tab streaming log viewer for running containers
- **Pull & update** — one-click image pull and stack redeploy

### App Store
- **Browse remote apps** — search and install apps from any CasaOS-compatible GitHub repository
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
- **HTTPS** — optional TLS via cert/key paths in config
- **Doctor dialog** — dependency checker for required system binaries

### Developer
- **Type-safe API** — Eden Treaty client with full end-to-end type inference
- **CasaOS compatible** — reads `x-casaos` metadata from existing app definitions

---

## Requirements

- [Bun](https://bun.sh) ≥ 1.1
- Docker with the Compose plugin (`docker compose`)

---

## Getting Started

```bash
# Clone
git clone git@github.com:deckyfx/anpan-os.git
cd anpan-os

# Install dependencies
bun install

# Run database migrations
bun run migrate

# Start (development, with hot reload)
bun run dev
```

Open `http://localhost:3000` and complete the setup wizard on first run.

---

## Configuration

On first run, a config file is created at `~/.anpanos/config.toml`:

```toml
[server]
port = 3000
bind = "local"   # "local" = 127.0.0.1 | "public" = 0.0.0.0
# tls_cert = "/path/to/cert.pem"
# tls_key  = "/path/to/key.pem"

[compose]
# folder = "/custom/path/composes"   # defaults to ~/.anpanos/composes

[files]
root = "/"   # root path the file manager can browse
```

All runtime data (config, database, compose files) lives under `~/.anpanos/` by default — easy to back up or relocate.

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
