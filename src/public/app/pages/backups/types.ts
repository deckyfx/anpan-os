/** A backup as GET /api/backups lists it. Mirrors BackupSummary in src/lib/backups.ts. */
export interface BackupSummary {
  id:        string;
  createdAt: string;
  version:   string;
  hostname:  string;
  dataRoot:  string;
  system:    boolean;
  apps:      { name: string; live: boolean; wasRunning: boolean; dataDirs: string[] }[];
  size:      number;
}

/** GET /api/backups. */
export interface BackupsListing {
  folder:         string;
  dataRoot:       string;
  restorePending: boolean;
  backups:        BackupSummary[];
}

/** Bytes as a short size: 512 B, 1.4 MB, 3.2 GB. */
export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return i === 0 ? `${n} B` : `${n.toFixed(1)} ${units[i]}`;
}

/** What a backup holds, in a few words: "System and 3 apps". */
export function describeContents(b: Pick<BackupSummary, "system" | "apps">): string {
  const apps = b.apps.length === 0 ? null : `${b.apps.length} app${b.apps.length === 1 ? "" : "s"}`;
  if (b.system && apps) return `System and ${apps}`;
  return b.system ? "System" : apps ?? "Nothing";
}
