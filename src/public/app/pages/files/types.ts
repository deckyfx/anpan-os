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
