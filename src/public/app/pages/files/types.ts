export interface FileEntry {
  name:     string;
  path:     string;
  isDir:    boolean;
  size:     number;
  modified: number;
  ext:      string;
  mode:     string;
  uid:      number;
  gid:      number;
}

export type ViewMode = "list" | "grid";

export interface UploadItem {
  name:   string;
  loaded: number;
  total:  number;
  done:   boolean;
  error:  boolean;
}

export interface CtxMenu {
  x:     number;
  y:     number;
  entry: FileEntry | null;
}

export interface SambaShare {
  name:        string;
  path:        string;
  comment:     string;
  readOnly:    boolean;
  browseable:  boolean;
  guestOk:     boolean;
  /** "anpan" = managed by anpan-os | "external" = from another config (casaos, etc.) */
  source:      "anpan" | "external";
  sourceFile?: string;
}

/**
 * What the server's share backend can actually honour.
 *
 * The UI renders against these rather than assuming Samba: a backend with no place to put
 * a comment should not be offered one, because the value would be accepted and dropped.
 */
export interface ShareCapabilities {
  comment:        boolean;
  browseable:     boolean;
  masks:          boolean;
  requiresSetup:  boolean;
  serviceControl: boolean;
}

/** Which backend is publishing shares, and whether it is ready to. */
export interface ShareBackend {
  provider:     "samba" | "apple" | null;
  providerName?: string;
  capabilities?: ShareCapabilities;
  ready:        boolean;
  detail:       string;
  fixable:      boolean;
}

export interface FileBookmark {
  name: string;
  path: string;
}

export interface FileBrowserConfig {
  startPath:       string;
  persistLastPath: boolean;
  lastPath:        string;
  bookmarks:       FileBookmark[];
}
