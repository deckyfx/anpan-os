// ─── Result type ─────────────────────────────────────────────────────────────

/** Discriminated union describing what the CLI was asked to do. */
export type CliResult =
  | { type: "version" }
  | { type: "help" }
  | { type: "doctor" }
  | { type: "reset-user" }
  | { type: "serve" };

// ─── Help text ────────────────────────────────────────────────────────────────

/** Print the help text to stdout. */
export function printHelp(): void {
  const version = process.env.APP_VERSION ?? "dev";
  console.log(`anpan-os v${version}

Usage: anpan-os [options]

Options:
  -v, --version    Print version and exit
  -h, --help       Show this help and exit
  --doctor         Check required system dependencies and exit
  --reset-user     Wipe the users table (re-run setup wizard on next start)

anpan-os must run as root to enable all features:
  - Docker & Compose stack management
  - Full filesystem access in the file manager
  - CasaOS stack migration

Config: /root/.anpanos/config.toml  (created on first run)
Docs:   https://github.com/deckyfx/anpan-os`);
}

// ─── Parser ───────────────────────────────────────────────────────────────────

/** Parse Bun.argv and return a typed CliResult. Never throws. */
export function parseCli(): CliResult {
  const argv = Bun.argv;

  if (argv.includes("-v") || argv.includes("--version")) return { type: "version" };
  if (argv.includes("-h") || argv.includes("--help"))    return { type: "help" };
  if (argv.includes("--doctor"))                         return { type: "doctor" };
  if (argv.includes("--reset-user"))                     return { type: "reset-user" };

  return { type: "serve" };
}
