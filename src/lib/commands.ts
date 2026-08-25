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

import { EXTRA_BIN_DIRS, PLATFORM, type Platform } from "./platform";

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
    feature:     "service restart, samba reload (Linux)",
    binary:      { linux: "systemctl" }, // macOS uses launchctl / brew services
    installHint: {
      linux:  "Built-in (systemd)",
      darwin: "Not applicable — anpan-os uses launchctl / brew services on macOS",
    },
  },
  ss: {
    name:        "ss",
    description: "Socket statistics — list listening ports",
    feature:     "port scanner (Linux)",
    binary:      { linux: "ss" }, // macOS has no iproute2; the port scanner uses lsof there
    installHint: {
      linux:  "Built-in (iproute2) — apt install iproute2  /  yum install iproute",
      darwin: "Not applicable — the port scanner uses lsof on macOS",
    },
  },
  lsof: {
    name:        "lsof",
    description: "List open files and sockets",
    feature:     "port scanner (macOS)",
    binary:      { darwin: "lsof" }, // Linux uses ss, which reports the same thing faster
    installHint: {
      linux:  "Not applicable — the port scanner uses ss on Linux",
      darwin: "Built-in",
    },
  },
  vm_stat: {
    name:        "vm_stat",
    description: "Virtual-memory statistics",
    feature:     "system stats — RAM usage (macOS)",
    binary:      { darwin: "vm_stat" }, // Linux reads /proc/meminfo instead
    installHint: {
      linux:  "Not applicable — RAM is read from /proc/meminfo on Linux",
      darwin: "Built-in",
    },
  },
  sharing: {
    name:        "sharing",
    description: "macOS sharepoint manager",
    feature:     "samba — native share management (macOS)",
    binary:      { darwin: "sharing" }, // Linux publishes shares through smb.conf instead
    installHint: {
      linux:  "Not applicable — shares are defined in smb.conf on Linux",
      darwin: "Built-in (/usr/sbin/sharing)",
    },
  },
  launchctl: {
    name:        "launchctl",
    description: "launchd service manager",
    feature:     "service restart, samba reload (macOS)",
    binary:      { darwin: "launchctl" }, // the systemd counterpart
    installHint: {
      linux:  "Not applicable — use systemctl on Linux",
      darwin: "Built-in",
    },
  },
  brew: {
    name:        "brew",
    description: "Homebrew package manager",
    feature:     "samba — service control, installing optional tools (macOS)",
    binary:      { darwin: "brew" },
    installHint: {
      linux:  "Not applicable",
      darwin: "https://brew.sh — /bin/bash -c \"$(curl -fsSL https://raw.githubusercontent.com/Homebrew/brew/HEAD/install.sh)\"",
    },
  },
  smbcontrol: {
    name:        "smbcontrol",
    description: "Samba control tool",
    feature:     "samba — reload config without restart",
    binary:      { linux: "smbcontrol", darwin: "smbcontrol" },
    installHint: {
      linux:  "apt install samba-common-bin  /  yum install samba",
      darwin: "brew install samba  (Apple's built-in sharing is configured in System Settings)",
    },
  },
  smbd: {
    name:        "smbd",
    description: "Samba daemon",
    feature:     "samba — file sharing service",
    binary:      { linux: "smbd", darwin: "smbd" },
    installHint: {
      linux:  "apt install samba  /  yum install samba",
      darwin: "brew install samba",
    },
  },
  rsync: {
    name:        "rsync",
    description: "Fast file copy/move with progress",
    feature:     "file manager — copy and move operations",
    binary:      { linux: "rsync", darwin: "rsync" },
    installHint: {
      linux:  "apt install rsync  /  yum install rsync",
      darwin: "brew install rsync",
    },
  },
  cp: {
    name:        "cp",
    description: "Copy files and directories",
    feature:     "file manager — copy operations (rsync fallback)",
    binary:      { linux: "cp", darwin: "cp" },
    installHint: {
      linux:  "Built-in (coreutils)",
      darwin: "Built-in",
    },
  },
  mv: {
    name:        "mv",
    description: "Move / rename files and directories",
    feature:     "file manager — move operations",
    binary:      { linux: "mv", darwin: "mv" },
    installHint: {
      linux:  "Built-in (coreutils)",
      darwin: "Built-in",
    },
  },
  du: {
    name:        "du",
    description: "Disk usage — folder size calculation",
    feature:     "file manager — calculate folder size",
    binary:      { linux: "du", darwin: "du" },
    installHint: {
      linux:  "Built-in (coreutils)",
      darwin: "Built-in",
    },
  },
  ffmpeg: {
    name:        "ffmpeg",
    description: "Audio and video transcoding",
    feature:     "file manager — convert FLAC to MP3",
    binary:      { linux: "ffmpeg", darwin: "ffmpeg" },
    installHint: {
      linux:  "apt install ffmpeg  /  yum install ffmpeg",
      darwin: "brew install ffmpeg",
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
  /**
   * False when the tool has no role on this platform at all.
   *
   * Distinct from `available`, and the distinction matters: systemctl and ss are absent on
   * macOS by design, because launchctl and lsof do those jobs there. Counting them as
   * missing told a Mac user that three tools needed installing, listed two that cannot be
   * installed, and exited non-zero — so the doctor reported a broken system on a healthy
   * one.
   */
  applicable:  boolean;
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

  /**
   * Cached availability, keyed by tool.
   *
   * Whether a binary exists is asked on hot paths — every file copy checks rsync, every
   * port scan checks docker — and answering it costs a `which` plus a handful of stats.
   * The answer does not change while the process runs, short of someone installing
   * something underneath it, which `refresh()` covers for the doctor screen.
   *
   * The promise is cached rather than the boolean, so concurrent callers share one probe
   * instead of racing to run it.
   */
  private availability = new Map<ToolId, Promise<boolean>>();

  /** Resolve the binary name for a tool on the current OS. Returns undefined if not applicable. */
  bin(id: ToolId): string | undefined {
    const binaries = this.tools[id].binary as Partial<Record<Platform, string>>;
    return binaries[PLATFORM];
  }

  /**
   * True if the tool is installed and runnable on this host.
   *
   * Two separate questions live here, and conflating them is the bug this guards against:
   * `bins.docker` being set means only that Docker is *conceivable* on this OS, not that
   * anyone installed it. On a stock macOS there is no Docker, no ffmpeg and no smbcontrol,
   * so anything that shells out to them must ask this first and report "not installed"
   * rather than surfacing a raw "command not found".
   */
  isAvailable(id: ToolId): Promise<boolean> {
    let probe = this.availability.get(id);
    if (!probe) {
      probe = this.probe(id);
      this.availability.set(id, probe);
    }
    return probe;
  }

  /**
   * The binary name to invoke, or undefined when the tool is missing.
   *
   * The shape callers want: one await that answers "can I run this, and as what", so a
   * guard is a single line rather than a paired bins lookup and availability check that
   * can drift apart.
   */
  async which(id: ToolId): Promise<string | undefined> {
    return (await this.isAvailable(id)) ? this.bin(id) : undefined;
  }

  /** Discard cached availability — used by the doctor so a fresh install is picked up. */
  refresh(): void {
    this.availability.clear();
  }

  private async probe(id: ToolId): Promise<boolean> {
    const binary = this.bin(id);
    if (!binary) return false;
    const result = await Bun.$`which ${binary}`.quiet().nothrow();
    if (result.exitCode === 0) return true;
    // sudo sanitises PATH and drops the sbin dirs; a macOS LaunchAgent gets a minimal
    // PATH with no Homebrew on it at all. EXTRA_BIN_DIRS covers both.
    for (const dir of EXTRA_BIN_DIRS) {
      if (await Bun.file(`${dir}/${binary}`).exists()) return true;
    }
    return false;
  }

  /** Run a full doctor check — returns one result per registered tool. */
  async doctor(): Promise<DoctorResult[]> {
    // The point of opening the doctor is usually that something was just installed.
    this.refresh();
    return Promise.all(
      (Object.keys(this.tools) as ToolId[]).map(async (id) => {
        const def    = this.tools[id];
        const binary = this.bin(id);
        const hints  = def.installHint as Partial<Record<Platform, string>>;
        const hint   = hints[PLATFORM] ?? hints.linux ?? "See documentation";
        return {
          id,
          name:        def.name,
          feature:     def.feature,
          binary,
          applicable:  binary !== undefined,
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

function resolveBins(): Partial<Record<ToolId, string>> {
  return Object.fromEntries(
    (Object.keys(TOOLS) as ToolId[])
      .flatMap((id) => {
        const binary = (TOOLS[id].binary as Partial<Record<Platform, string>>)[PLATFORM];
        return binary !== undefined ? [[id, binary]] : [];
      }),
  );
}

export const bins = resolveBins();
