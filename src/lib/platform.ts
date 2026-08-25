/**
 * Platform abstraction — the single place that knows how Linux and macOS differ.
 *
 * anpan-os was written for a Linux box running systemd, Docker Engine and a package
 * manager that puts everything in /usr/bin. macOS answers every one of those questions
 * differently: launchd instead of systemd, a Docker socket under the user's home, and
 * Homebrew under /opt/homebrew on Apple Silicon but /usr/local on Intel. Scattering
 * `process.platform === "darwin"` through the routes would make each of those a separate
 * thing to remember, so the differences are named once here and imported everywhere else.
 */

import { homedir } from "node:os";
import { existsSync, lstatSync, readdirSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";

export type Platform = "linux" | "darwin" | "win32";
export type Arch     = "x64" | "arm64";

export const PLATFORM = process.platform as Platform;
export const IS_LINUX = PLATFORM === "linux";
export const IS_MACOS = PLATFORM === "darwin";

/** Normalised architecture — the two we publish binaries for. */
export const ARCH: Arch = process.arch === "arm64" ? "arm64" : "x64";

/** macOS on Apple Silicon (M1 and later). */
export const IS_APPLE_SILICON = IS_MACOS && ARCH === "arm64";

/** Short label for messages: "macOS (Apple Silicon)", "Linux (x64)". */
export const PLATFORM_LABEL = IS_MACOS
  ? `macOS (${IS_APPLE_SILICON ? "Apple Silicon" : "Intel"})`
  : `${PLATFORM} (${ARCH})`;

/** Release-asset and build-output name for an OS/arch pair. Defaults to this host. */
export function binaryName(platform: Platform = PLATFORM, arch: Arch = ARCH): string {
  const os = platform === "win32" ? "windows" : platform;
  return `anpan-os-${os}-${arch}`;
}

/** The binary this process is running from — the thing a self-update has to replace. */
export function currentBinaryPath(): string {
  return process.execPath;
}

// ─── Homebrew ────────────────────────────────────────────────────────────────

/**
 * Homebrew's installation prefix, or null off macOS.
 *
 * Apple Silicon installs to /opt/homebrew, Intel to /usr/local, and neither is on the
 * PATH a launchd-started process inherits. Resolved by looking for the `brew` binary so
 * an unusual prefix still works, falling back to the documented default for the arch.
 */
export const BREW_PREFIX: string | null = (() => {
  if (!IS_MACOS) return null;
  const fromEnv = Bun.env.HOMEBREW_PREFIX;
  if (fromEnv && existsSync(join(fromEnv, "bin", "brew"))) return fromEnv;
  for (const prefix of ["/opt/homebrew", "/usr/local"]) {
    if (existsSync(join(prefix, "bin", "brew"))) return prefix;
  }
  return IS_APPLE_SILICON ? "/opt/homebrew" : "/usr/local";
})();

/**
 * Directories to search when a binary is not on $PATH.
 *
 * Two separate problems: sudo sanitises PATH and drops the sbin directories, and a macOS
 * daemon launched by launchd gets a minimal PATH with no Homebrew in it at all.
 */
export const EXTRA_BIN_DIRS: string[] = IS_MACOS
  ? [
      ...(BREW_PREFIX ? [join(BREW_PREFIX, "bin"), join(BREW_PREFIX, "sbin")] : []),
      "/usr/local/bin", "/usr/local/sbin", "/usr/sbin", "/sbin", "/opt/local/bin",
    ]
  : ["/usr/sbin", "/sbin", "/usr/local/sbin", "/usr/local/bin"];

// ─── Filesystem layout ───────────────────────────────────────────────────────

/**
 * Where runtime state (config.toml, the SQLite database, samba.conf) lives by default.
 *
 * anpan-os runs as a root system service on both platforms — a systemd unit on Linux, a
 * LaunchDaemon on macOS — so this is a system location, not a per-user one. /usr/local/var
 * is the macOS counterpart of /var/lib and, unlike a Homebrew prefix, is the same path on
 * Apple Silicon and Intel, so state does not move when a machine is replaced.
 */
export const DEFAULT_CONFIG_DIR: string = IS_MACOS
  ? "/usr/local/var/anpan-os"
  : "/var/lib/anpan-os";

/**
 * Where the installers put the binary, and where a self-update writes it back.
 *
 * /usr/local/bin deliberately, not the Homebrew prefix: it is on the default PATH on both
 * Apple Silicon and Intel, and it keeps anpan-os out of a directory `brew` manages and
 * may prune.
 */
export const DEFAULT_INSTALL_DIR = "/usr/local/bin";

/** System-wide samba configuration — the file we add one `include =` line to. */
export const DEFAULT_SMB_CONF: string = IS_MACOS
  ? join(BREW_PREFIX ?? "/usr/local", "etc", "smb.conf")
  : "/etc/samba/smb.conf";

/** CasaOS app directory. CasaOS is Linux-only; on macOS nothing is there to import. */
export const CASAOS_APPS_DIR = "/var/lib/casaos/apps";

// ─── Docker socket ───────────────────────────────────────────────────────────

/** Socket paths relative to a home directory, by Docker runtime. */
const HOME_RELATIVE_SOCKETS = [
  [".docker", "run", "docker.sock"],       // Docker Desktop
  [".orbstack", "run", "docker.sock"],     // OrbStack
  [".colima", "default", "docker.sock"],   // Colima
  [".rd", "docker.sock"],                  // Rancher Desktop
] as const;

/**
 * Home directories that might contain a Docker socket.
 *
 * anpan-os runs as a system-wide LaunchDaemon on macOS, so `homedir()` is /var/root and
 * every macOS Docker runtime has put its socket in a *human* user's home. Docker Desktop
 * only links /var/run/docker.sock when its privileged-helper option is enabled, so relying
 * on that path means Docker silently missing on a normal install.
 *
 * Running as root is what makes the alternative work: the socket is mode 0660 owned by the
 * user, and root bypasses those checks, so the daemon can connect to a socket it does not
 * own. Scanning /Users is therefore a real fix rather than a guess — but only for root.
 * As a non-root user, someone else's socket is unreachable and listing it would only
 * produce a confusing permission error instead of a clear "Docker not found".
 */
function candidateHomes(): string[] {
  const homes = [homedir()];
  if (!IS_MACOS) return homes;

  const isRoot = (process.getuid?.() ?? -1) === 0;
  if (!isRoot) return homes;

  // Real accounts only: /Users also holds Shared and .localized.
  //
  // Sorted, because readdir order is filesystem-defined and not stable: without this, a
  // host with two Docker users could bind to a different daemon between reboots, and
  // Docker operations here include pruning volumes.
  try {
    const accounts = readdirSync("/Users", { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith(".") && e.name !== "Shared")
      .map(e => e.name)
      .sort();
    for (const name of accounts) homes.push(join("/Users", name));
  } catch { /* unreadable /Users — fall back to our own home */ }

  return homes;
}

/**
 * Candidate Docker socket paths, most specific first.
 *
 * DOCKER_HOST wins when set, matching what the `docker` CLI itself does, so an explicit
 * override is always honoured before anything is probed.
 */
export function dockerSocketCandidates(): string[] {
  // An explicit unix:// DOCKER_HOST is the whole list, not the head of it.
  //
  // Probing past it split the application in two: the HTTP client would fall through to
  // some other socket it found, while `docker compose` — which reads DOCKER_HOST itself —
  // kept using the configured one. Container listings and stack operations would then be
  // talking to different daemons, and `docker system prune` would reclaim from whichever
  // the cleanup client had picked. A configured socket that is missing must fail as a
  // configured socket that is missing.
  const explicit = explicitDockerSocket();
  if (explicit) return [explicit];

  const candidates: string[] = [];

  if (IS_MACOS) {
    for (const home of candidateHomes()) {
      for (const parts of HOME_RELATIVE_SOCKETS) candidates.push(join(home, ...parts));
    }
  }

  candidates.push("/var/run/docker.sock");
  return candidates;
}

/**
 * Canonical path of a socket, following one level of symlink.
 *
 * `realpathSync` cannot be used on the socket itself: on macOS it fails with EOPNOTSUPP
 * for a socket node, and the failure is silent enough to look like "no symlink here" —
 * which defeated the deduplication this exists for. The link is read directly instead, and
 * only the containing directory is canonicalised, which is where /var → /private/var and
 * any other directory symlink gets resolved.
 */
function canonicalSocketPath(path: string): string {
  try {
    const target   = lstatSync(path).isSymbolicLink() ? readlinkSync(path) : path;
    const absolute = isAbsolute(target) ? target : join(dirname(path), target);
    return join(realpathSync(dirname(absolute)), basename(absolute));
  } catch {
    return path;
  }
}

/** The socket named by DOCKER_HOST, when it names one over a unix path. */
export function explicitDockerSocket(): string | null {
  const host = Bun.env.DOCKER_HOST;
  return host?.startsWith("unix://") ? host.slice("unix://".length) : null;
}

/**
 * The Docker socket to talk to.
 *
 * Resolved once at module load: the socket does not move while the process runs, and
 * re-probing the filesystem on every API call would cost a stat per request. When none of
 * the candidates exist we still return the conventional path, so the resulting error says
 * "cannot connect to /var/run/docker.sock" rather than naming something invented.
 */
export const DOCKER_SOCKET: string = (() => {
  const candidates = dockerSocketCandidates();

  const found = candidates.filter((path) => {
    try { return statSync(path).isSocket(); } catch { return false; }
  });

  // Distinct *daemons*, not distinct paths. Docker Desktop links /var/run/docker.sock to
  // the socket in the user's home, so the two paths that turn up on a perfectly ordinary
  // Mac are one daemon — and warning about that would put a spurious line in the log on
  // every boot for most users.
  const distinct = new Set(found.map(canonicalSocketPath));

  // Several users each have their own Docker runtime. Root can reach all of them, and
  // nothing in the filesystem says which one the administrator meant — so the choice is
  // announced rather than made silently, and DOCKER_HOST is offered to settle it.
  // Refusing outright was the other option, but this service starts unattended at boot,
  // and a host that stops managing containers because a second account once ran Docker is
  // a worse failure than a named default.
  if (distinct.size > 1) {
    console.warn(
      `⚠️  Multiple Docker sockets found; using ${found[0]}\n` +
      `   Others: ${found.slice(1).join(", ")}\n` +
      `   Set DOCKER_HOST=unix://<path> to choose explicitly.`,
    );
  }

  // Nothing found: still name the conventional path, so the error a caller reports is
  // "cannot connect to /var/run/docker.sock" rather than something invented.
  return found[0] ?? candidates[candidates.length - 1]!;
})();

/**
 * Point the `docker` CLI at the same socket the HTTP client found.
 *
 * The API client is told the socket path directly, but half of anpan-os shells out to
 * `docker compose`, and that child process does its own lookup: it reads root's
 * ~/.docker/config.json, finds no context, falls back to /var/run/docker.sock and fails —
 * so stacks would break while the container list worked. Exporting DOCKER_HOST puts both
 * paths on the same socket. An explicit DOCKER_HOST is left alone.
 */
export function ensureDockerHost(): void {
  if (Bun.env.DOCKER_HOST) return;
  try {
    if (statSync(DOCKER_SOCKET).isSocket()) process.env.DOCKER_HOST = `unix://${DOCKER_SOCKET}`;
  } catch { /* no socket to point at — leave the CLI to report it */ }
}

// ─── Service management ──────────────────────────────────────────────────────
//
// Only the identifiers live here. The verbs — restart, reboot, power off, query state —
// belong to the service provider in lib/providers/service, which is where systemd and
// launchd actually diverge.

/** The launchd label and plist path the macOS installers write. */
export const LAUNCHD_LABEL      = "io.anpan.anpan-os";
export const LAUNCHD_PLIST_PATH = `/Library/LaunchDaemons/${LAUNCHD_LABEL}.plist`;

// ─── PATH repair ─────────────────────────────────────────────────────────────

/**
 * Extra directories where a macOS Docker CLI is likely to live.
 *
 * Docker Desktop symlinks into /usr/local/bin, but OrbStack keeps its shims under the
 * user's home and Colima ships through Homebrew — none of which a launchd-started process
 * necessarily sees.
 */
function macDockerCliDirs(): string[] {
  const home = homedir();
  return [
    "/usr/local/bin",                                   // Docker Desktop symlinks
    "/Applications/Docker.app/Contents/Resources/bin",  // Docker Desktop, unlinked
    join(home, ".docker", "bin"),
    join(home, ".orbstack", "bin"),
    join(home, ".rd", "bin"),                           // Rancher Desktop
  ];
}

/**
 * Put the directories we know about onto $PATH, once, at startup.
 *
 * launchd hands a daemon a minimal PATH — typically just /usr/bin:/bin:/usr/sbin:/sbin —
 * with no Homebrew and no Docker Desktop on it. Every `Bun.$` call in the app then fails
 * with "command not found" even though the tool is installed and works in a terminal.
 * Repairing PATH here fixes all of them at once, instead of each caller having to know
 * where its own binary lives.
 *
 * Only appends: anything the environment already provides keeps its precedence.
 */
export function ensureToolPath(): void {
  if (!IS_MACOS) return;

  const current = (Bun.env.PATH ?? "").split(":").filter(Boolean);
  const seen    = new Set(current);
  const added: string[] = [];

  for (const dir of [...EXTRA_BIN_DIRS, ...macDockerCliDirs()]) {
    if (seen.has(dir) || !existsSync(dir)) continue;
    seen.add(dir);
    added.push(dir);
  }

  if (added.length === 0) return;
  process.env.PATH = [...current, ...added].join(":");
}

// ─── Feature availability ────────────────────────────────────────────────────

/**
 * Platform-gated features.
 *
 * Reported to the browser by GET /api/system/info so the UI can leave out what cannot
 * work here, rather than offering a button that fails. A control that errors every time
 * is worse than one that is absent: the user cannot tell an unsupported feature from a
 * broken one.
 */
export interface PlatformFeatures {
  /** CasaOS stack import — reads /var/lib/casaos, which only exists on a CasaOS host. */
  casaosMigration: boolean;
  /** Reboot / shutdown the host. */
  powerControl: boolean;
  /** Samba share management. */
  samba: boolean;
  /** Replace the running binary from a GitHub release and restart the service. */
  selfUpdate: boolean;
}

export const FEATURES: PlatformFeatures = {
  // CasaOS itself does not run on macOS, so there is never anything to migrate from.
  casaosMigration: IS_LINUX,
  powerControl:    IS_LINUX || IS_MACOS,
  // Whether shares can actually be managed depends on which SMB server is installed,
  // which cannot be answered without running something — see detectSamba().
  samba:           IS_LINUX || IS_MACOS,
  selfUpdate:      IS_LINUX || IS_MACOS,
};

// ─── SMB server detection ────────────────────────────────────────────────────

/**
 * Which SMB server is installed.
 *
 * - "samba" — the real Samba suite. Reads smb.conf, honours `include =`, and is what
 *   every share anpan-os writes depends on.
 * - "apple" — macOS ships /usr/sbin/smbd, but it is Apple's own SMBX, not Samba. It does
 *   not read smb.conf at all: its shares live in Open Directory and are configured through
 *   System Settings → General → Sharing.
 * - "none" — no SMB server at all.
 */
export type SmbFlavor = "samba" | "apple" | "none";

export interface SambaSupport {
  flavor: SmbFlavor;
  /** True only when anpan-os can actually create shares by writing config. */
  manageable: boolean;
  /** Why not, when manageable is false. */
  reason?: string;
}

/**
 * Work out whether shares written by anpan-os would have any effect.
 *
 * The distinction is not pedantic. A plain `which smbd` succeeds on a stock Mac, so
 * treating that as "Samba is installed" would let the UI accept shares, write them to a
 * file, report success — and have nothing happen, because Apple's daemon never reads that
 * file. A share that silently does not exist is the worst outcome available here, so the
 * flavour is established before the feature is offered.
 *
 * Samba is identified by its suite rather than by the daemon: smbcontrol and testparm ship
 * with Samba and have no Apple counterpart, so either one is conclusive. Checking the
 * daemon's own --version is not, because Apple's smbd exits non-zero on unknown flags and
 * would be indistinguishable from a Samba build too old to answer.
 */
export async function detectSamba(): Promise<SambaSupport> {
  const { commands } = await import("./commands");

  const [hasSmbcontrol, hasSmbd] = await Promise.all([
    commands.isAvailable("smbcontrol"),
    commands.isAvailable("smbd"),
  ]);

  if (hasSmbcontrol) return { flavor: "samba", manageable: true };

  if (!hasSmbd) {
    return {
      flavor: "none",
      manageable: false,
      reason: IS_MACOS
        ? "No SMB server found. Install Samba with: brew install samba"
        : "Samba is not installed — see System Doctor",
    };
  }

  // smbd without the suite. On macOS that is Apple's SMBX; on Linux it is a Samba install
  // missing samba-common-bin, which is a packaging gap rather than a different product.
  if (IS_MACOS) {
    return {
      flavor: "apple",
      manageable: false,
      reason:
        "macOS ships Apple's SMB server, which does not read smb.conf — shares defined here " +
        "would have no effect. Use System Settings → General → Sharing, or install Samba " +
        "with: brew install samba",
    };
  }

  return { flavor: "samba", manageable: true };
}
