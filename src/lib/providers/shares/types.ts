/**
 * Share provider — the contract every SMB backend implements.
 *
 * anpan-os originally had exactly one way to publish a share: write a `.conf` file and add
 * an `include =` line to smb.conf. That is Samba's model, and it is not portable. macOS
 * ships its own SMB server whose shares live in Open Directory and are managed with verbs
 * (`sharing -a/-e/-r`), not with a config file — so a provider interface shaped like
 * "render me some config text" would fit one backend and not the other.
 *
 * The interface is therefore verb-based, and the config-file mechanics are an implementation
 * detail of the Samba provider rather than part of the contract.
 */

/** A share as anpan-os models it. The SQLite row and the API body share this shape. */
export interface ShareDefinition {
  name:       string;
  path:       string;
  comment:    string;
  readOnly:   boolean;
  browseable: boolean;
  guestOk:    boolean;
}

/** A share as read back from the backend, plus where it came from. */
export interface DiscoveredShare extends ShareDefinition {
  /** "anpan" = created here | "external" = defined by something else on this host. */
  source:      "anpan" | "external";
  /** Where the definition lives — a conf path for Samba, a record name for Apple. */
  sourceFile?: string;
}

/**
 * What the active backend can actually honour.
 *
 * Reported to the browser so the UI can disable a field rather than accept input the
 * backend will silently drop. Accepting a value and discarding it is the failure mode this
 * whole module exists to avoid: a share that appears to have been configured and has not.
 */
export interface ShareCapabilities {
  /** Per-share description string. Samba has `comment =`; Apple has no equivalent. */
  comment:        boolean;
  /** Hide a share from network browsing. Samba only. */
  browseable:     boolean;
  /** create mask / directory mask. Samba only; macOS inherits ACLs from the parent. */
  masks:          boolean;
  /** Whether the backend needs a one-time "patch the system config" step before it works. */
  requiresSetup:  boolean;
  /** Whether the provider can start/stop the SMB service itself. */
  serviceControl: boolean;
}

/** Whether the backend is wired up and ready to serve shares. */
export interface SetupStatus {
  /** True when nothing further is needed before shares take effect. */
  ready:   boolean;
  /** Human-readable explanation — shown verbatim in the UI. */
  detail:  string;
  /** True when the user can fix this from anpan-os (i.e. setup() would help). */
  fixable: boolean;
}

/**
 * Why a share operation failed, in terms the HTTP layer can map to a status code.
 *
 * Backends report failure very differently — Samba by writing a file that smbd may later
 * reject, Apple by a non-zero exit and a one-line message. Normalising here keeps that
 * difference out of the routes.
 */
export type ShareErrorKind =
  | "conflict"    // a share with that name already exists          → 409
  | "not-found"   // no such share                                  → 404
  | "bad-path"    // the path does not exist or is not a directory  → 400
  | "unsupported" // the backend cannot do this at all              → 501
  | "denied"      // insufficient privileges                        → 403
  | "failed";     // anything else                                  → 500

export class ShareError extends Error {
  constructor(readonly kind: ShareErrorKind, message: string) {
    super(message);
    this.name = "ShareError";
  }
}

/** Maps a ShareError to the HTTP status the routes should return. */
export function statusFor(kind: ShareErrorKind): number {
  switch (kind) {
    case "conflict":    return 409;
    case "not-found":   return 404;
    case "bad-path":    return 400;
    case "unsupported": return 501;
    case "denied":      return 403;
    default:            return 500;
  }
}

export interface ShareProvider {
  readonly id:    "samba" | "apple";
  /** Shown in the UI so the user knows which backend is in charge. */
  readonly label: string;
  readonly capabilities: ShareCapabilities;

  /** Every share this host publishes, ours and other people's. */
  list(): Promise<DiscoveredShare[]>;

  create(share: ShareDefinition): Promise<void>;
  /** Applies only the fields present; `name` identifies the existing share. */
  update(name: string, patch: Partial<ShareDefinition>): Promise<void>;
  remove(name: string): Promise<void>;

  /**
   * Bring the backend's view in line with the given set.
   *
   * Reconciliation, not replacement: a host may carry shares anpan-os did not create —
   * defined in System Settings, or by another admin — and rewriting the world would delete
   * them. Only shares anpan-os owns are added, changed or removed.
   */
  sync(shares: ShareDefinition[]): Promise<void>;

  /**
   * Take an existing share defined elsewhere on this host under anpan-os management.
   *
   * What that means differs sharply. Samba keeps each source in its own file, so adopting
   * one means cutting the section out of the file that owns it — leaving it there would
   * give smbd two definitions of the same share. Apple keeps every sharepoint in one
   * Open Directory store, so there is nothing to move and adoption is purely a matter of
   * anpan-os starting to track it.
   */
  adopt(share: DiscoveredShare): Promise<void>;

  /** Ask a running server to re-read its configuration. A no-op where none is needed. */
  reload(): Promise<void>;

  status(): Promise<SetupStatus>;
  /** One-time wiring. Throws "unsupported" when capabilities.requiresSetup is false. */
  setup(): Promise<void>;
  teardown(): Promise<void>;
}
