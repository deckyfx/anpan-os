/**
 * macOS native SMB sharing, via /usr/sbin/sharing.
 *
 * macOS ships an SMB server, so making people `brew install samba` to share a folder is a
 * cost with nothing bought. Apple's server does not read smb.conf — its shares are records
 * in Open Directory — but `sharing` is a complete, scriptable front end to them, and the
 * whole of anpan-os's share model except `comment` maps onto it directly.
 *
 * Two facts about `sharing` drive the code below, both established by running it:
 *
 *  1. The *record name* and the *SMB name* are separate identifiers. `-n` sets the record
 *     name, which is the key `-e` and `-r` look up by and the key of the JSON listing;
 *     `-S` sets the name clients see. Looking a share up by its SMB name fails. Both are
 *     therefore written on create and kept identical, and the record name is the primary key.
 *
 *  2. It is silent on success and exits non-zero with a one-line reason on failure, and the
 *     reasons are distinct enough to classify — which is how create/update/remove report
 *     conflicts and missing paths rather than a generic failure.
 */

import { commands } from "../commands";
import {
  ShareError, type DiscoveredShare, type ShareCapabilities, type ShareDefinition,
  type ShareProvider, type SetupStatus,
} from "./types";

/** One entry of `sharing -l -f json`, keyed by record name. */
interface SharingRecord {
  path:              string;
  smb_name:          string;
  smb_shared:        number;
  smb_guest_access:  number;
  smb_read_only:     number;
  smb_sealed:        number;
}

/**
 * Classify a `sharing` failure from its message.
 *
 * Matching on text is unattractive, but the exit code is 1 for everything, so it is the
 * only signal available — and the alternative is reporting "failed" for a duplicate name
 * the user could fix in seconds. The fallback keeps an unrecognised message intact rather
 * than replacing it with something vaguer.
 */
function classify(stderr: string): ShareError {
  const msg = stderr.trim() || "sharing failed";
  if (/already exists/i.test(msg))                 return new ShareError("conflict",  msg);
  if (/unable to find share point record/i.test(msg)) return new ShareError("not-found", msg);
  if (/unable to stat|no such file or directory/i.test(msg)) return new ShareError("bad-path", msg);
  // `sharing` refuses outright for a non-root caller. anpan-os runs as a root LaunchDaemon
  // in production, so this is a development-time or misconfigured-service condition — and
  // 403 says that, where the generic 500 it used to return said nothing.
  if (/must be run as root/i.test(msg)) {
    return new ShareError("denied", "Managing macOS shares requires root — anpan-os must run as a system service.");
  }
  if (/permission denied|not permitted/i.test(msg)) return new ShareError("denied", msg);
  return new ShareError("failed", msg);
}

export class AppleShareProvider implements ShareProvider {
  readonly id = "apple" as const;
  readonly label = "macOS File Sharing";

  readonly capabilities: ShareCapabilities = {
    // Open Directory sharepoints have no description field. anpan-os keeps `comment` in its
    // own database and shows it in its own UI; it simply never reaches SMB clients.
    comment:        false,
    // No per-share browse toggle. Every sharepoint is visible.
    browseable:     false,
    // New files inherit the parent directory's ACL instead of a fixed mask.
    masks:          false,
    // Nothing to patch — creating the record is the whole of publishing it.
    requiresSetup:  false,
    // Turning File Sharing on is a System Settings action; see status().
    serviceControl: false,
  };

  /** Resolve the binary, or fail with a message naming what is missing. */
  private async bin(): Promise<string> {
    const sharing = await commands.which("sharing");
    if (!sharing) {
      throw new ShareError("unsupported", "/usr/sbin/sharing is not available on this system");
    }
    return sharing;
  }

  private async run(args: string[]): Promise<string> {
    const sharing = await this.bin();
    const proc = Bun.spawn([sharing, ...args], { stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0) throw classify(err || out);
    return out;
  }

  async list(): Promise<DiscoveredShare[]> {
    let raw: string;
    try {
      raw = await this.run(["-l", "-f", "json"]);
    } catch (e) {
      // A host with no sharepoints at all is not an error state.
      if (e instanceof ShareError && e.kind === "not-found") return [];
      throw e;
    }

    const text = raw.trim();
    if (!text) return [];

    let parsed: Record<string, SharingRecord>;
    try {
      parsed = JSON.parse(text) as Record<string, SharingRecord>;
    } catch {
      throw new ShareError("failed", "Could not parse the output of `sharing -l -f json`");
    }

    return Object.entries(parsed)
      // Records exist for shares that are defined but not published over SMB; they are not
      // shares from anpan-os's point of view.
      .filter(([, r]) => r.smb_shared === 1)
      .map(([record, r]) => ({
        // The record name is the key everything else addresses this share by.
        name:       record,
        path:       r.path,
        // Apple stores none, so anything shown comes from our own database.
        comment:    "",
        readOnly:   r.smb_read_only === 1,
        browseable: true,
        guestOk:    r.smb_guest_access === 1,
        // Ownership is decided by the caller against its own records: Open Directory is
        // shared with System Settings and carries no marker for who created an entry.
        source:     "external" as const,
        sourceFile: record,
      }));
  }

  async create(share: ShareDefinition): Promise<void> {
    await this.run([
      "-a", share.path,
      // Record name and SMB name are set together and kept identical, so the key the user
      // sees and the key we address the share by never diverge.
      "-n", share.name,
      "-S", share.name,
      // Flags are afp/ftp/smb in order; only the last is still supported.
      "-s", "001",
      "-g", share.guestOk ? "001" : "000",
      "-R", share.readOnly ? "1" : "0",
    ]);
  }

  async update(name: string, patch: Partial<ShareDefinition>): Promise<void> {
    const args = ["-e", name];

    // A rename has to move both identifiers; leaving the record name behind would keep
    // working but would show the user one name and respond to another.
    if (patch.name !== undefined && patch.name !== name) {
      args.push("-n", patch.name, "-S", patch.name);
    }
    if (patch.readOnly !== undefined) args.push("-R", patch.readOnly ? "1" : "0");
    if (patch.guestOk  !== undefined) args.push("-g", patch.guestOk ? "001" : "000");

    // `comment` and `browseable` are deliberately absent: the backend has nowhere to put
    // them, and capabilities.comment/browseable tell the UI not to offer them.
    if (args.length === 2) return; // nothing this backend can act on

    await this.run(args);

    // `sharing` has no flag to move an existing sharepoint, so a path change is a
    // remove-and-recreate. Done last, so a failure above leaves the share intact.
    if (patch.path !== undefined) {
      const current = (await this.list()).find(s => s.name === (patch.name ?? name));
      if (current && current.path !== patch.path) {
        const finalName = patch.name ?? name;
        await this.remove(finalName);
        await this.create({
          name:       finalName,
          path:       patch.path,
          comment:    patch.comment    ?? "",
          readOnly:   patch.readOnly   ?? current.readOnly,
          browseable: true,
          guestOk:    patch.guestOk    ?? current.guestOk,
        });
      }
    }
  }

  async remove(name: string): Promise<void> {
    await this.run(["-r", name]);
  }

  /**
   * Reconcile Open Directory with the shares anpan-os owns.
   *
   * Only names in `shares` are touched. Open Directory is shared with System Settings, so
   * anything else on the host belongs to someone else and removing it — which a
   * rewrite-everything implementation would do — would silently delete a user's own share.
   */
  async sync(shares: ShareDefinition[]): Promise<void> {
    const existing = new Map((await this.list()).map(s => [s.name, s]));

    for (const want of shares) {
      const have = existing.get(want.name);
      if (!have) {
        await this.create(want);
        continue;
      }
      // Only push what actually differs, so a no-op sync does not churn Open Directory.
      const patch: Partial<ShareDefinition> = {};
      if (have.path     !== want.path)     patch.path     = want.path;
      if (have.readOnly !== want.readOnly) patch.readOnly = want.readOnly;
      if (have.guestOk  !== want.guestOk)  patch.guestOk  = want.guestOk;
      if (Object.keys(patch).length > 0) await this.update(want.name, patch);
    }
  }

  /**
   * Nothing to move.
   *
   * Every sharepoint lives in the same Open Directory store, so a share created in System
   * Settings is already in exactly the place anpan-os would put it. Adoption is the caller
   * recording it in SQLite; the backend has nothing to do.
   */
  async adopt(): Promise<void> {}

  /** Nothing to reload: `sharing` writes to Open Directory, which smbd reads live. */
  async reload(): Promise<void> {}

  /**
   * Whether shares published here will actually be reachable.
   *
   * A sharepoint with the SMB service switched off is defined and invisible, which looks
   * exactly like a broken share. The daemon's state is therefore part of the answer, and
   * `fixable: false` reflects that turning File Sharing on is a System Settings action —
   * enabling a network service on the user's behalf is not anpan-os's call to make.
   */
  async status(): Promise<SetupStatus> {
    const running = await Bun.$`pgrep -x smbd`.quiet().nothrow();
    if (running.exitCode === 0) {
      return { ready: true, detail: "macOS File Sharing is on — shares are being served.", fixable: false };
    }
    return {
      ready:   false,
      detail:  "macOS File Sharing is off. Shares defined here will not be reachable until " +
               "it is switched on in System Settings → General → Sharing → File Sharing.",
      fixable: false,
    };
  }

  async setup(): Promise<void> {
    throw new ShareError(
      "unsupported",
      "macOS needs no setup step — turn File Sharing on in System Settings → General → Sharing.",
    );
  }

  async teardown(): Promise<void> {
    throw new ShareError("unsupported", "macOS has no setup step to undo.");
  }
}
