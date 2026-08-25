/**
 * Share provider selection.
 *
 * Chosen from what is actually installed rather than from the platform alone, because both
 * backends can be present on the same host: a Mac with Homebrew Samba has a working
 * smb.conf *and* Apple's native sharing, and the two publish shares independently.
 */

import { commands } from "../../commands";
import { IS_MACOS, detectSamba } from "../../platform";
import { AppleShareProvider }    from "./apple-provider";
import { SambaShareProvider }    from "./samba-provider";
import { ShareError, type ShareProvider } from "./types";

export * from "./types";
export { AppleShareProvider, SambaShareProvider };

/**
 * Resolved once per process.
 *
 * Installing Samba mid-run is not something to design around, and re-probing would put a
 * `which` on the path of every share request.
 */
let cached: Promise<ShareProvider | null> | null = null;

/**
 * The backend that will publish shares on this host, or null when none can.
 *
 * Samba wins where it exists, on either platform. It is the richer model — it is the only
 * one that can store a share's comment or hide it from browsing — and a user who installed
 * it did so deliberately. Apple's server is the macOS default precisely so that nobody has
 * to install anything: `brew install samba` is a real cost, and macOS can already share
 * files perfectly well without it.
 */
export function shareProvider(): Promise<ShareProvider | null> {
  cached ??= (async () => {
    const smb = await detectSamba();
    if (smb.flavor === "samba") return new SambaShareProvider();

    // The Apple provider's prerequisite is `sharing`, not smbd: it writes sharepoint
    // records, and whether a daemon is running to serve them is a separate question its
    // status() answers. Checking for the tool rather than assuming macOS implies it keeps
    // "we can manage shares" from being claimed on a host where nothing can.
    if (IS_MACOS && await commands.isAvailable("sharing")) return new AppleShareProvider();

    return null;
  })();
  return cached;
}

/** Clears the cached selection. For tests, and after a tool install. */
export function resetShareProvider(): void {
  cached = null;
}

/**
 * The active provider, or a typed error explaining why there is none.
 *
 * Routes that must publish something call this; routes that merely display state call
 * shareProvider() and render the null case.
 */
export async function requireShareProvider(): Promise<ShareProvider> {
  const provider = await shareProvider();
  if (provider) return provider;
  const smb = await detectSamba();
  throw new ShareError("unsupported", smb.reason ?? "No SMB server is available on this system");
}
