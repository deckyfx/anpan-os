import { useCallback, useEffect, useState } from "react";
import { HardDrive, Usb, RefreshCw, Lock } from "lucide-react";
import { api } from "../../lib/api";
import { useFileStore } from "../../stores/fileStore";

/** One drive or partition as /api/system/drives reports it. */
interface Drive {
  device:      string;
  mount:       string | null;
  label:       string | null;
  total:       number;
  used:        number | null;
  removable:   boolean;
  browsable:   boolean;
  unavailable: string | null;
}

/** Drives come and go, so the list is re-read on this interval while the panel is open. */
const POLL_MS = 10_000;

function formatSize(bytes: number): string {
  if (bytes >= 1_099_511_627_776) return `${(bytes / 1_099_511_627_776).toFixed(1)} TB`;
  if (bytes >= 1_073_741_824)     return `${(bytes / 1_073_741_824).toFixed(0)} GB`;
  if (bytes >= 1_048_576)         return `${(bytes / 1_048_576).toFixed(0)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

/** The name worth showing: the label if the filesystem has one, else the bare device. */
function displayName(d: Drive): string {
  if (d.label) return d.label;
  if (d.mount === "/") return "System";
  return d.device.replace("/dev/", "");
}

/**
 * Which drive the current directory lives on — the mount that is the longest prefix of the
 * path. Longest wins because /mnt/ssd02 and / both match a file under /mnt/ssd02.
 */
function activeMount(drives: Drive[], currentPath: string): string | null {
  return drives
    .map(d => d.mount)
    .filter((m): m is string => m !== null)
    .filter(m => currentPath === m || currentPath.startsWith(m === "/" ? "/" : `${m}/`))
    .sort((a, b) => b.length - a.length)[0] ?? null;
}

const cardClass  = "bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-2";
const labelClass = "text-[10px] font-semibold text-gray-600 uppercase tracking-widest";

/**
 * Quick access to every drive and partition on the machine.
 *
 * Replaces the earlier single-disk widget, which only ever showed the disk holding the
 * current directory — useful as a readout, useless for getting to a second disk or a
 * thumbdrive, which is what this panel is for.
 */
export function DrivesPanel({ currentPath }: { currentPath: string }) {
  const [drives,   setDrives]   = useState<Drive[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const navigateTo = useFileStore(s => s.navigateTo);

  const load = useCallback(async () => {
    try {
      const { data } = await (api.api.system as unknown as {
        drives: { get: () => Promise<{ data: Drive[] | null }> };
      }).drives.get();
      if (data) setDrives(data);
    } catch { /* transient: keep the last good list rather than blanking the panel */ }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const refresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  if (!drives) {
    return (
      <div className={`${cardClass} animate-pulse`}>
        <p className={labelClass}>Drives</p>
        <div className="h-3 bg-gray-800 rounded w-3/4" />
      </div>
    );
  }

  const active = activeMount(drives, currentPath);

  return (
    <div className={cardClass}>
      <div className="flex items-center justify-between">
        <p className={labelClass}>Drives</p>
        <button
          onClick={() => void refresh()}
          title="Rescan drives"
          className="text-gray-600 hover:text-gray-300 transition-colors disabled:opacity-50"
          disabled={refreshing}
        >
          <RefreshCw size={12} className={refreshing ? "animate-spin" : ""} />
        </button>
      </div>

      {drives.length === 0 && <p className="text-xs text-gray-600">No drives detected.</p>}

      <div className="space-y-2.5">
        {drives.map((d) => {
          const isActive = d.mount !== null && d.mount === active;
          const pct = d.used !== null && d.total > 0
            ? Math.min(100, Math.round((d.used / d.total) * 100))
            : null;
          const barColor = pct === null ? "bg-gray-700"
            : pct > 85 ? "bg-red-500" : pct > 65 ? "bg-yellow-400" : "bg-violet-500";

          return (
            <button
              key={d.device}
              onClick={() => { if (d.browsable && d.mount) void navigateTo(d.mount); }}
              disabled={!d.browsable}
              // The reason is on the element itself, so an unmounted drive explains
              // why it cannot be opened rather than looking broken.
              title={d.browsable ? `Open ${d.mount}` : `${d.device} — ${d.unavailable}`}
              className={`w-full text-left rounded-lg px-2 py-1.5 transition-colors border
                ${isActive
                  ? "bg-violet-500/10 border-violet-500/30"
                  : d.browsable
                    ? "border-transparent hover:bg-gray-800 cursor-pointer"
                    : "border-transparent opacity-50 cursor-not-allowed"}`}
            >
              <div className="flex items-center gap-1.5 text-xs">
                {d.removable
                  ? <Usb size={12} className="shrink-0 text-amber-400" />
                  : <HardDrive size={12} className="shrink-0 text-gray-500" />}
                <span className={`truncate font-medium ${isActive ? "text-violet-300" : "text-gray-300"}`}>
                  {displayName(d)}
                </span>
                {!d.browsable && <Lock size={10} className="shrink-0 text-gray-600 ml-auto" />}
              </div>

              <div className="flex items-center justify-between gap-2 mt-0.5 text-[10px] text-gray-600">
                <span className="truncate">{d.mount ?? d.unavailable}</span>
                <span className="shrink-0">
                  {pct !== null ? `${pct}% of ${formatSize(d.total)}` : formatSize(d.total)}
                </span>
              </div>

              <div className="h-1 bg-gray-800 rounded-full overflow-hidden mt-1">
                <div className={`h-full rounded-full transition-all ${barColor}`}
                  style={{ width: `${pct ?? 0}%` }} />
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
