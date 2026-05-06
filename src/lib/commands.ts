/**
 * CommandRegistry — single source of truth for every external binary the app invokes.
 *
 * Usage in callers:
 *   import { bins } from "../lib/commands";
 *   await Bun.$`${bins.docker} compose up -d`.cwd(dir).nothrow();
 *
 * Doctor check:
 *   import { commands } from "../lib/commands";
 *   const report = await commands.doctor();
 */

type Platform = "linux" | "darwin" | "win32";

export interface ToolDef {
  /** Human-readable name shown in doctor output. */
  name: string;
  /** What this tool does. */
  description: string;
  /** Which app feature(s) require it. */
  feature: string;
  /** Binary name per OS — omit a platform key if the tool is not applicable there. */
  binary: Partial<Record<Platform, string>>;
  /** Short install instructions per OS. */
  installHint: Partial<Record<Platform, string>>;
}

/** All external binaries the app may invoke. Keys are stable identifiers. */
const TOOLS = {
  docker: {
    name:        "Docker",
    description: "Container runtime and Compose orchestration",
    feature:     "docker management, compose stacks",
    binary:      { linux: "docker", darwin: "docker" },
    installHint: {
      linux:  "https://docs.docker.com/engine/install/",
      darwin: "Install Docker Desktop — https://www.docker.com/products/docker-desktop/",
    },
  },
  zip: {
    name:        "zip",
    description: "File compression",
    feature:     "file manager — zip archives",
    binary:      { linux: "zip", darwin: "zip" },
    installHint: {
      linux:  "apt install zip  /  yum install zip",
      darwin: "brew install zip",
    },
  },
  unzip: {
    name:        "unzip",
    description: "File extraction",
    feature:     "file manager — unzip archives",
    binary:      { linux: "unzip", darwin: "unzip" },
    installHint: {
      linux:  "apt install unzip  /  yum install unzip",
      darwin: "brew install unzip  (or: xcode-select --install)",
    },
  },
  df: {
    name:        "df",
    description: "Disk-usage reporting",
    feature:     "system stats — disk space",
    binary:      { linux: "df", darwin: "df" },
    installHint: {
      linux:  "Built-in (coreutils)",
      darwin: "Built-in",
    },
  },
  systemctl: {
    name:        "systemctl",
    description: "Systemd service manager",
    feature:     "samba — service reload",
    binary:      { linux: "systemctl" }, // not present on macOS
    installHint: {
      linux:  "Built-in (systemd)",
      darwin: "Not applicable — use: brew services restart samba",
    },
  },
} as const satisfies Record<string, ToolDef>;

export type ToolId = keyof typeof TOOLS;

// ─── Doctor result ────────────────────────────────────────────────────────────

export interface DoctorResult {
  id:          ToolId;
  name:        string;
  feature:     string;
  binary:      string | undefined; // undefined = not applicable on this OS
  available:   boolean;
  installHint: string;
}

// ─── Registry singleton ───────────────────────────────────────────────────────

class CommandRegistry {
  private static _instance: CommandRegistry;

  static getInstance(): CommandRegistry {
    if (!CommandRegistry._instance) {
      CommandRegistry._instance = new CommandRegistry();
    }
    return CommandRegistry._instance;
  }

  readonly tools: typeof TOOLS = TOOLS;

  /** Resolve the binary name for a tool on the current OS. Returns undefined if not applicable. */
  bin(id: ToolId): string | undefined {
    const platform = process.platform as Platform;
    const binaries = this.tools[id].binary as Partial<Record<Platform, string>>;
    return binaries[platform] ?? binaries.linux;
  }

  /** Returns true if the binary is present on $PATH. */
  async isAvailable(id: ToolId): Promise<boolean> {
    const binary = this.bin(id);
    if (!binary) return false;
    const result = await Bun.$`which ${binary}`.quiet().nothrow();
    return result.exitCode === 0;
  }

  /** Run a full doctor check — returns one result per registered tool. */
  async doctor(): Promise<DoctorResult[]> {
    return Promise.all(
      (Object.keys(this.tools) as ToolId[]).map(async (id) => {
        const def     = this.tools[id];
        const platform = process.platform as Platform;
        const binary  = this.bin(id);
        const hints   = def.installHint as Partial<Record<Platform, string>>;
        const hint    = hints[platform] ?? hints.linux ?? "See documentation";
        return {
          id,
          name:        def.name,
          feature:     def.feature,
          binary,
          available:   await this.isAvailable(id),
          installHint: hint,
        };
      }),
    );
  }
}

export const commands = CommandRegistry.getInstance();

// ─── Resolved binaries — use directly in Bun.$ template literals ─────────────
// Resolved once at module load for the current OS.

function resolveBins(): Record<ToolId, string> {
  const platform = process.platform as Platform;
  return Object.fromEntries(
    (Object.keys(TOOLS) as ToolId[]).map((id) => {
      const binaries = TOOLS[id].binary as Partial<Record<Platform, string>>;
      const binary   = binaries[platform] ?? binaries.linux ?? id;
      return [id, binary];
    }),
  ) as Record<ToolId, string>;
}

export const bins = resolveBins();
