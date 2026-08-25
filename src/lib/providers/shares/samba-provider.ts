/**
 * Samba, via smb.conf.
 *
 * The original — and only — backend: anpan-os writes its shares to a `.conf` file of its
 * own and adds a single `include =` line to the system smb.conf so Samba picks them up.
 * Owning one file rather than editing the user's means a mistake here cannot corrupt a
 * configuration anpan-os did not write, and removing anpan-os is one line to delete.
 *
 * This runs on Linux, and on macOS when the user has installed real Samba (`brew install
 * samba`) in preference to Apple's server — the mechanics are identical, only the paths
 * and the service manager differ.
 */

import { mkdirSync } from "node:fs";
import { realpath }   from "node:fs/promises";
import { config }     from "../../../config";
import { envConfig }  from "../../../env-config";
import { commands }   from "../../commands";
import { IS_LINUX, IS_MACOS } from "../../platform";
import { service } from "../service";
import {
  ShareError, type DiscoveredShare, type ShareCapabilities, type ShareDefinition,
  type ShareProvider, type SetupStatus,
} from "./types";

// ─── Conf parsing and serialisation ──────────────────────────────────────────

/** Parse a conf file that contains only [ShareName] sections (no [global]). */
export function parseShares(raw: string, source: DiscoveredShare["source"] = "anpan"): DiscoveredShare[] {
  const shares: DiscoveredShare[] = [];
  let current: Partial<DiscoveredShare> | null = null;

  function flush() {
    if (current?.name) {
      shares.push({
        name:       current.name,
        path:       current.path       ?? "",
        comment:    current.comment    ?? "",
        readOnly:   current.readOnly   ?? false,
        browseable: current.browseable ?? true,
        guestOk:    current.guestOk    ?? false,
        source,
      });
    }
    current = null;
  }

  for (const line of raw.split("\n")) {
    const trimmed      = line.trim();
    const sectionMatch = trimmed.match(/^\[(.+)\]$/);

    if (sectionMatch) {
      const sectionName = sectionMatch[1]!;
      flush();
      if (sectionName.toLowerCase() !== "global") current = { name: sectionName };
      continue;
    }

    if (current) {
      const kv = trimmed.match(/^([^=]+?)\s*=\s*(.*)$/);
      if (kv) {
        const key = kv[1]!.trim().toLowerCase().replace(/\s+/g, " ");
        const val = kv[2]!.trim();
        switch (key) {
          case "path":       current.path       = val; break;
          case "comment":    current.comment    = val; break;
          case "read only":  current.readOnly   = val.toLowerCase() === "yes"; break;
          case "browseable": current.browseable = val.toLowerCase() !== "no";  break;
          case "guest ok":   current.guestOk    = val.toLowerCase() === "yes"; break;
        }
      }
    }
  }
  flush();
  return shares;
}

/** Serialise shares to conf-file text (no [global]). */
export function sharesToConf(shares: ShareDefinition[]): string {
  return shares.map((s) => [
    `[${s.name}]`,
    `   comment = ${s.comment}`,
    `   path = ${s.path}`,
    `   browseable = ${s.browseable ? "Yes" : "No"}`,
    `   read only = ${s.readOnly ? "Yes" : "No"}`,
    `   guest ok = ${s.guestOk ? "Yes" : "No"}`,
    `   create mask = 0644`,
    `   directory mask = 0755`,
  ].join("\n")).join("\n\n");
}

// ─── System smb.conf include management ──────────────────────────────────────

// Written as a comment line above the include so the path has no inline comment —
// samba's include parser does not strip inline # comments from the path value.
const INCLUDE_MARKER = "# managed by anpan-os";

/** The block injected into smb.conf (inside an explicit [global] for scope). */
function includeBlock(): string {
  return `[global]\n   ${INCLUDE_MARKER}\n   include = ${config.sambaSharesPath}`;
}

async function readSystemConf(): Promise<string | null> {
  const file = Bun.file(config.smbConfPath);
  if (!(await file.exists())) return null;
  return file.text();
}

/**
 * Remove any injected anpan-os block from smb.conf text.
 * Matches the exact 3-line structure includeBlock() produces; unrelated content is untouched.
 */
function stripAnpanBlock(raw: string): string {
  const lines = raw.split("\n");
  const result: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (
      lines[i]?.trim() === "[global]" &&
      lines[i + 1]?.includes(INCLUDE_MARKER) &&
      lines[i + 2]?.trim().startsWith("include =")
    ) {
      i += 3;
      continue;
    }
    result.push(lines[i]!);
    i++;
  }
  return result.join("\n");
}

/**
 * Remove the [shareName] section from a samba conf file's text.
 *
 * A section runs from its [header] to the next [header] or end of file. Blank lines
 * between sections are preserved so adopting a share does not reflow a file anpan-os
 * does not own.
 */
export function removeShareSection(raw: string, shareName: string): string {
  const result: string[] = [];
  let skip = false;
  for (const line of raw.split("\n")) {
    const sectionMatch = line.trim().match(/^\[(.+)\]$/);
    if (sectionMatch) skip = sectionMatch[1] === shareName;
    if (!skip) result.push(line);
  }
  return result.join("\n");
}

export class SambaShareProvider implements ShareProvider {
  readonly id = "samba" as const;
  readonly label = "Samba";

  // Samba's own model, so everything anpan-os records survives a round trip.
  readonly capabilities: ShareCapabilities = {
    comment:        true,
    browseable:     true,
    masks:          true,
    // smb.conf has to be told to include our file before any share takes effect.
    requiresSetup:  true,
    serviceControl: true,
  };

  /** Rewrite our managed conf file from the given set. */
  private async writeConf(shares: ShareDefinition[]): Promise<void> {
    mkdirSync(envConfig.RUNTIME_CONFIG_DIR, { recursive: true });
    const text = sharesToConf(shares);
    await Bun.write(config.sambaSharesPath, text ? text + "\n" : "");
  }

  private async readOwnShares(): Promise<DiscoveredShare[]> {
    const file = Bun.file(config.sambaSharesPath);
    if (!(await file.exists())) return [];
    return parseShares(await file.text(), "anpan");
  }

  /**
   * Every share on the host: ours, plus any other file smb.conf includes.
   *
   * Our own conf is matched by canonical path rather than by string, so a symlinked or
   * differently-spelled include does not read back as somebody else's share.
   */
  async list(): Promise<DiscoveredShare[]> {
    const own = await this.readOwnShares();
    const ownReal = await realpath(config.sambaSharesPath).catch(() => config.sambaSharesPath);

    const rawConf = await readSystemConf();
    const external: DiscoveredShare[] = [];

    if (rawConf) {
      const includePattern = /^[ \t]*include\s*=\s*(.+?)(?:\s*#.*)?$/gm;
      let match: RegExpExecArray | null;
      while ((match = includePattern.exec(rawConf)) !== null) {
        const includePath = match[1]!.trim();
        const includeReal = await realpath(includePath).catch(() => includePath);
        if (includeReal === ownReal) continue;
        try {
          const file = Bun.file(includePath);
          if (await file.exists()) {
            external.push(
              ...parseShares(await file.text(), "external").map(s => ({ ...s, sourceFile: includePath })),
            );
          }
        } catch { /* unreadable — skip */ }
      }
    }

    const ownNames = new Set(own.map(s => s.name));
    return [...own, ...external.filter(s => !ownNames.has(s.name))];
  }

  async create(share: ShareDefinition): Promise<void> {
    const own = await this.readOwnShares();
    if (own.some(s => s.name === share.name)) {
      throw new ShareError("conflict", `A share named "${share.name}" already exists`);
    }
    await this.writeConf([...own, share]);
    await this.reload();
  }

  async update(name: string, patch: Partial<ShareDefinition>): Promise<void> {
    const own = await this.readOwnShares();
    const idx = own.findIndex(s => s.name === name);
    if (idx < 0) throw new ShareError("not-found", `No share named "${name}"`);

    if (patch.name && patch.name !== name && own.some(s => s.name === patch.name)) {
      throw new ShareError("conflict", `A share named "${patch.name}" already exists`);
    }

    own[idx] = { ...own[idx]!, ...patch };
    await this.writeConf(own);
    await this.reload();
  }

  async remove(name: string): Promise<void> {
    const own = await this.readOwnShares();
    if (!own.some(s => s.name === name)) throw new ShareError("not-found", `No share named "${name}"`);
    await this.writeConf(own.filter(s => s.name !== name));
    await this.reload();
  }

  /**
   * Rewrite our conf from the given set.
   *
   * Safe to replace wholesale, unlike the Apple backend: this file is anpan-os's alone, and
   * shares belonging to anything else live in other files that smb.conf includes separately.
   */
  async sync(shares: ShareDefinition[]): Promise<void> {
    await this.writeConf(shares);
    await this.reload();
  }

  /**
   * Move a share out of the file that currently defines it and into ours.
   *
   * Both definitions cannot stand: smbd reads every included file, and two `[name]`
   * sections for one share is a configuration error. The section is cut from the source
   * file first and our conf rewritten second, so a failure part-way leaves the share
   * defined once rather than twice.
   */
  async adopt(share: DiscoveredShare): Promise<void> {
    if (share.sourceFile) {
      const src = Bun.file(share.sourceFile);
      if (await src.exists()) {
        await Bun.write(share.sourceFile, removeShareSection(await src.text(), share.name));
      }
    }
    const own = await this.readOwnShares();
    if (!own.some(s => s.name === share.name)) {
      await this.writeConf([...own, share]);
    }
    await this.reload();
  }

  /**
   * Ask a running smbd to re-read its configuration.
   *
   * Ordered by how little it disturbs existing connections. smbcontrol is the right tool
   * and behaves identically on both platforms, but it ships with Samba and so cannot be
   * assumed; the fallback is the service manager, which differs — systemd reloads in place
   * while launchd has no reload verb and must restart.
   *
   * Doing nothing is a legitimate outcome: the conf on disk is already correct, and a host
   * with no running server has nothing to tell.
   */
  async reload(): Promise<void> {
    const smbcontrol = await commands.which("smbcontrol");
    if (smbcontrol) {
      const proc = Bun.spawn([smbcontrol, "smbd", "reload-config"], { stdout: "pipe", stderr: "pipe" });
      // A non-zero exit here usually means smbd is not running, which is not a failure of
      // the operation that prompted the reload.
      await proc.exited;
      return;
    }

    if (IS_LINUX) {
      // systemd can reload in place; the service provider knows how.
      await service.reload("smbd");
      return;
    }

    if (IS_MACOS) {
      // Deliberately not the service provider: on macOS it maps "smbd" to com.apple.smbd,
      // and a Homebrew Samba is a different job entirely (homebrew.mxcl.samba), managed
      // through `brew services`. Restarting Apple's daemon would reload the wrong server.
      const brew = await commands.which("brew");
      if (brew) await Bun.spawn([brew, "services", "restart", "samba"], { stdout: "pipe", stderr: "pipe" }).exited;
    }
  }

  async status(): Promise<SetupStatus> {
    const raw = await readSystemConf();
    if (!raw) {
      return {
        ready:   false,
        detail:  `${config.smbConfPath} does not exist — is Samba installed?`,
        fixable: false,
      };
    }
    if (!raw.includes(INCLUDE_MARKER)) {
      return {
        ready:   false,
        detail:  `${config.smbConfPath} does not yet include anpan-os's share file.`,
        fixable: true,
      };
    }
    return { ready: true, detail: `${config.smbConfPath} includes anpan-os's share file.`, fixable: false };
  }

  /** Inject our include block into smb.conf. Requires root. */
  async setup(): Promise<void> {
    const raw = await readSystemConf();
    if (!raw) throw new ShareError("bad-path", `${config.smbConfPath} not found`);
    if (raw.includes(INCLUDE_MARKER)) return;
    try {
      await Bun.write(config.smbConfPath, stripAnpanBlock(raw).trimEnd() + "\n" + includeBlock() + "\n");
    } catch (e) {
      throw new ShareError("denied", `Could not write ${config.smbConfPath}: ${(e as Error).message}`);
    }
    await this.reload();
  }

  /** Remove our include block from smb.conf. Requires root. */
  async teardown(): Promise<void> {
    const raw = await readSystemConf();
    if (!raw) throw new ShareError("bad-path", `${config.smbConfPath} not found`);
    if (!raw.includes(INCLUDE_MARKER)) return;
    try {
      await Bun.write(config.smbConfPath, stripAnpanBlock(raw).trimEnd() + "\n");
    } catch (e) {
      throw new ShareError("denied", `Could not write ${config.smbConfPath}: ${(e as Error).message}`);
    }
    await this.reload();
  }
}
