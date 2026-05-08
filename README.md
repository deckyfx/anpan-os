# anpan-os

A lightweight self-hosted home server dashboard built with **Bun**, **ElysiaJS**, and **React**.

Manage your Docker Compose stacks, browse files, and monitor system resources — all from a single web UI with no external dependencies beyond Docker and Bun.

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

- **Docker Compose dashboard** — install, start, stop, restart, and delete stacks; stream live install logs
- **File manager** — browse, upload, download, rename, and delete files on the host
- **System monitor** — CPU, memory, disk, and network stats in the sidebar
- **CasaOS compatible** — reads metadata (`x-casaos` blocks) from existing CasaOS app definitions
- **Auth** — JWT session-based login; bcrypt password storage
- **HTTPS** — optional TLS via cert/key paths in config
- **Type-safe API** — Eden Treaty client with full end-to-end type inference

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
├── plugins/                # Route plugins (auth, docker, compose, files…)
├── stores/                 # DB repository classes
└── public/
    └── app/
        ├── components/     # Shared UI components
        ├── lib/            # Eden Treaty API client
        ├── pages/          # React page components
        └── stores/         # Zustand client stores
```

---

## License

MIT — see [LICENSE](LICENSE).
