import { DEFAULT_CONFIG_DIR } from "./lib/platform";

// ─── Result type ─────────────────────────────────────────────────────────────

/** Discriminated union describing what the CLI was asked to do. */
export type CliResult =
  | { type: "version" }
  | { type: "help" }
  | { type: "doctor" }
  | { type: "compose-doctor"; all: boolean }
  | { type: "compose-repair"; stacks: string[]; all: boolean }
  | { type: "reset-user" }
  | { type: "upgrade"; checkOnly: boolean }
  | { type: "serve" }
  | { type: "invalid"; message: string };

// ─── Help text ────────────────────────────────────────────────────────────────

/** Print the help text to stdout. */
export function printHelp(): void {
  const version = process.env.APP_VERSION ?? "dev";
  const configDir = Bun.env.RUNTIME_CONFIG_DIR ?? DEFAULT_CONFIG_DIR;
  console.log(`anpan-os v${version}

Usage: anpan-os [options]

With no options, starts the server.

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
  --upgrade        Install the latest release over this binary and restart the
                   service. Needs root. Add --check to only report whether a
                   newer release exists.

anpan-os must run as root to enable all features:
  - Docker & Compose stack management
  - Full filesystem access in the file manager
  - CasaOS stack migration

Config: ${configDir}/config.toml  (created on first run)
Docs:   https://github.com/deckyfx/anpan-os`);
}

// ─── Parser ───────────────────────────────────────────────────────────────────

/** Options that select what the binary does. The first one present wins. */
const COMMANDS = [
  "-v", "--version", "-h", "--help", "--doctor", "--compose-doctor",
  "--compose-repair", "--reset-user", "--upgrade",
] as const;

/** Options that only modify a command, and the commands they belong to. */
const MODIFIERS: Record<string, readonly string[]> = {
  "--all":   ["--compose-doctor", "--compose-repair"],
  "--check": ["--upgrade"],
};

/**
 * Parse the command line and return a typed CliResult. Never throws or exits.
 *
 * Takes the user's arguments — `Bun.argv` from index 2, where they begin both when run from
 * source and in a compiled binary.
 *
 * Anything not recognised is an error, never a reason to start the server. That used to be
 * the fallback: `anpan-os upgrade` — no such command — started a full server in the current
 * directory, reading whatever config that directory pointed at. Only a bare `anpan-os`
 * starts the server now, which is how every installed service runs it.
 */
export function parseCli(args: readonly string[] = Bun.argv.slice(2)): CliResult {
  const repairIdx = args.indexOf("--compose-repair");

  for (const [i, arg] of args.entries()) {
    // Own properties only: `in` also matches what every object inherits, so `constructor`,
    // `toString` or `__proto__` counted as modifiers and fell through to starting the server.
    if ((COMMANDS as readonly string[]).includes(arg) || Object.hasOwn(MODIFIERS, arg)) continue;
    // Stack names are the one bare word allowed, and only after --compose-repair.
    if (!arg.startsWith("-") && repairIdx !== -1 && i > repairIdx) continue;

    if (arg.startsWith("-")) return { type: "invalid", message: `Unknown option: ${arg}` };
    const hint = (COMMANDS as readonly string[]).includes(`--${arg}`) ? ` Did you mean --${arg}?` : "";
    return { type: "invalid", message: `Unknown command: ${arg}.${hint}` };
  }

  for (const [modifier, owners] of Object.entries(MODIFIERS)) {
    if (args.includes(modifier) && !owners.some(o => args.includes(o))) {
      return { type: "invalid", message: `${modifier} only goes with ${owners.join(" or ")}.` };
    }
  }

  if (args.includes("-v") || args.includes("--version")) return { type: "version" };
  if (args.includes("-h") || args.includes("--help"))    return { type: "help" };
  if (args.includes("--doctor"))                         return { type: "doctor" };

  const all = args.includes("--all");
  if (args.includes("--compose-doctor")) return { type: "compose-doctor", all };

  if (repairIdx !== -1) {
    const stacks = args.slice(repairIdx + 1).filter(a => !a.startsWith("-"));
    if (stacks.length === 0 && !all) {
      return {
        type: "invalid",
        message: "--compose-repair needs one or more stack names, or --all.\n"
          + "Run 'anpan-os --compose-doctor' to see which stacks need repair.",
      };
    }
    return { type: "compose-repair", stacks, all };
  }

  if (args.includes("--reset-user")) return { type: "reset-user" };
  if (args.includes("--upgrade"))    return { type: "upgrade", checkOnly: args.includes("--check") };

  return { type: "serve" };
}
