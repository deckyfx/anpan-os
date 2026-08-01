// ─── Result type ─────────────────────────────────────────────────────────────

/** Discriminated union describing what the CLI was asked to do. */
export type CliResult =
  | { type: "version" }
  | { type: "help" }
  | { type: "doctor" }
  | { type: "compose-doctor"; all: boolean }
  | { type: "compose-repair"; stacks: string[]; all: boolean }
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
  --compose-doctor Report which compose file each stack's containers came from
                   (add --all to list healthy stacks too)
  --compose-repair Re-anchor stacks onto the managed compose folder by recreating
                   their containers. Takes stack names, or --all for every
                   stack that needs it. Containers restart; volumes are kept.
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

  const all = argv.includes("--all");
  if (argv.includes("--compose-doctor")) return { type: "compose-doctor", all };

  const repairIdx = argv.indexOf("--compose-repair");
  if (repairIdx !== -1) {
    // Every non-flag argument after --compose-repair is a stack name.
    const stacks = argv.slice(repairIdx + 1).filter(a => !a.startsWith("-"));
    if (stacks.length === 0 && !all) {
      console.error("Error: --compose-repair needs one or more stack names, or --all.\n");
      console.error("Run 'anpan-os --compose-doctor' to see which stacks need repair.\n");
      process.exit(1);
    }
    return { type: "compose-repair", stacks, all };
  }

  if (argv.includes("--reset-user"))                     return { type: "reset-user" };

  return { type: "serve" };
}
