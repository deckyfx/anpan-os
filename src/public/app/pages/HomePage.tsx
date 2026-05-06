import React, { useCallback, useEffect, useRef, useState } from "react";
import { Drawer }    from "../components/Drawer";
import { Dialog }    from "../components/Dialog";
import { LogViewer } from "../components/LogViewer";

// ─── API types ────────────────────────────────────────────────────────────────

interface DockerPort {
  PublicPort?: number;
}

interface DockerService {
  id: string;
  service: string;
  image: string;
  state: string;
  ports: DockerPort[];
}

interface StackMeta {
  id: string;
  title: string | null;
  icon: string | null;
  tagline: string | null;
  portMap: string | null;
  scheme: string | null;
  indexPath: string | null;
  mainService: string | null;
  note: string | null;
  managed: boolean | null;
}

interface Stack {
  name: string;
  services: DockerService[];
  state: "running" | "partial" | "stopped";
  /** Icon URL from Docker "icon" container label (CasaOS). */
  icon?: string;
  /** DB-persisted metadata — null only before first sync. */
  meta: StackMeta | null;
}

interface SystemStats {
  cpu: number;
  ramUsed: number;
  ramTotal: number;
  diskUsed: number;
  diskTotal: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toGB(bytes: number): string {
  return (bytes / 1_073_741_824).toFixed(1) + "G";
}

function buildLaunchUrl(stack: Stack): string | null {
  const meta  = stack.meta;
  const port  = meta?.portMap ?? String(stack.services.flatMap(s => s.ports).find(p => p.PublicPort)?.PublicPort ?? "");
  if (!port) return null;
  const scheme = meta?.scheme ?? "http";
  const index  = meta?.indexPath ?? "/";
  return `${scheme}://${window.location.hostname}:${port}${index}`;
}

const stackStateColor: Record<Stack["state"], string> = {
  running: "bg-green-400",
  partial: "bg-yellow-400",
  stopped: "bg-red-400",
};

// ─── Top bar ──────────────────────────────────────────────────────────────────

function IconSignOut() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M15 21h4a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2h-4" />
      <polyline points="8 17 3 12 8 7" />
      <line x1="3" y1="12" x2="15" y2="12" />
    </svg>
  );
}

function TopBar({ username, version, onLogout }: {
  username: string;
  version: string;
  onLogout: () => void;
}) {
  const handleLogout = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    onLogout();
  };

  return (
    <header className="h-12 border-b border-gray-800 px-5 flex items-center justify-between gap-4 shrink-0 bg-gray-950/80 backdrop-blur-sm">
      <div className="flex items-center gap-2.5">
        <span className="text-lg">🍞</span>
        <span className="font-bold text-amber-400 tracking-wide">anpan-os</span>
        <span className="text-xs text-gray-600 font-mono">v{version}</span>
      </div>

      <div className="flex items-center gap-3">
        <span className="text-xs text-gray-400">{username}</span>
        <button
          onClick={handleLogout}
          title="Sign out"
          className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-white transition-colors px-2.5 py-1.5 rounded-lg hover:bg-gray-800"
        >
          <IconSignOut />
          Sign out
        </button>
      </div>
    </header>
  );
}

// ─── Left panel widgets ───────────────────────────────────────────────────────

function ClockWidget() {
  const [now, setNow] = useState(new Date());

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const timeStr = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const dateStr = now.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
      <p className="text-3xl font-mono font-semibold text-white tabular-nums">{timeStr}</p>
      <p className="text-xs text-gray-500 mt-1">{dateStr}</p>
    </div>
  );
}

function CalendarWidget() {
  const now        = new Date();
  const year       = now.getFullYear();
  const month      = now.getMonth();
  const today      = now.getDate();
  const monthName  = now.toLocaleDateString([], { month: "long", year: "numeric" });
  const firstDay   = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  const cells: (number | null)[] = [];
  for (let i = 0; i < firstDay; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
      <p className="text-xs font-semibold text-gray-300 mb-3">{monthName}</p>
      <div className="grid grid-cols-7 gap-0.5 text-center text-xs">
        {["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map((d, i) => (
          <span key={i} className="text-gray-600 pb-1 font-medium">{d}</span>
        ))}
        {cells.map((day, i) => (
          <span
            key={i}
            className={`py-0.5 rounded-md leading-5 ${
              day === today
                ? "bg-amber-500 text-black font-bold"
                : day
                  ? "text-gray-300"
                  : ""
            }`}
          >
            {day ?? ""}
          </span>
        ))}
      </div>
    </div>
  );
}

function StatBar({ label, used, total, color }: {
  label: string;
  used: number;
  total: number;
  color: string;
}) {
  const pct = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0;
  return (
    <div>
      <div className="flex justify-between text-xs mb-1.5">
        <span className="text-gray-500">{label}</span>
        <span className="text-gray-300 tabular-nums">{toGB(used)} / {toGB(total)}</span>
      </div>
      <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden">
        <div className={`h-full ${color} rounded-full transition-all duration-700`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function SystemWidget({ stats }: { stats: SystemStats | null }) {
  if (!stats) {
    return (
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 text-xs text-gray-600 animate-pulse">
        Loading…
      </div>
    );
  }

  const cpuColor = stats.cpu > 80 ? "bg-red-500" : stats.cpu > 50 ? "bg-yellow-400" : "bg-green-400";

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-3">
      <p className="text-[10px] font-semibold text-gray-600 uppercase tracking-widest">Resources</p>

      {/* CPU */}
      <div>
        <div className="flex justify-between text-xs mb-1.5">
          <span className="text-gray-500">CPU</span>
          <span className="text-gray-300 tabular-nums">{stats.cpu}%</span>
        </div>
        <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden">
          <div className={`h-full ${cpuColor} rounded-full transition-all duration-700`} style={{ width: `${stats.cpu}%` }} />
        </div>
      </div>

      <StatBar label="RAM"  used={stats.ramUsed}  total={stats.ramTotal}  color="bg-blue-500" />
      <StatBar label="Disk" used={stats.diskUsed} total={stats.diskTotal} color="bg-violet-500" />
    </div>
  );
}

function NetworkWidget() {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
      <p className="text-[10px] font-semibold text-gray-600 uppercase tracking-widest mb-3">Network</p>
      <div className="space-y-2 text-xs">
        <div className="flex justify-between items-center">
          <span className="text-gray-500">Host</span>
          <span className="text-gray-300 font-mono truncate max-w-27.5">{window.location.hostname}</span>
        </div>
        <div className="flex justify-between items-center">
          <span className="text-gray-500">Port</span>
          <span className="text-gray-300 font-mono">{window.location.port || "443"}</span>
        </div>
        <div className="flex items-center gap-2 pt-1">
          <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
          <span className="text-gray-500">Online</span>
        </div>
      </div>
    </div>
  );
}

// ─── Bottom bar ───────────────────────────────────────────────────────────────

function BottomBar({ stacks }: { stacks: Stack[] }) {
  const running = stacks.filter((s) => s.state === "running").length;
  const partial = stacks.filter((s) => s.state === "partial").length;
  const stopped = stacks.filter((s) => s.state === "stopped").length;

  const items = [
    running > 0 ? `● ${running} running` : null,
    partial > 0 ? `◑ ${partial} partial` : null,
    stopped > 0 ? `○ ${stopped} stopped` : null,
    stacks.length === 0 ? "No stacks" : null,
  ].filter(Boolean).join("   ·   ");

  return (
    <footer className="h-7 border-t border-gray-800 px-4 flex items-center gap-3 text-[10px] text-gray-600 shrink-0 overflow-hidden select-none">
      <span className="text-gray-700 font-semibold tracking-widest uppercase shrink-0">Status</span>
      <span className="w-px h-3 bg-gray-800 shrink-0" />
      <span className="truncate">{items}</span>
    </footer>
  );
}

// ─── Edit metadata dialog ─────────────────────────────────────────────────────

interface EditMetaDialogProps {
  stack: Stack;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}

function EditMetaDialog({ stack, open, onClose, onSaved }: EditMetaDialogProps) {
  const m = stack.meta;
  const [title,     setTitle]     = useState(m?.title     ?? "");
  const [icon,      setIcon]      = useState(m?.icon      ?? "");
  const [portMap,   setPortMap]   = useState(m?.portMap   ?? "");
  const [scheme,    setScheme]    = useState(m?.scheme    ?? "http");
  const [indexPath, setIndexPath] = useState(m?.indexPath ?? "/");
  const [tagline,   setTagline]   = useState(m?.tagline   ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // Sync state when meta changes (e.g. after CasaOS import)
  useEffect(() => {
    setTitle(m?.title ?? "");
    setIcon(m?.icon ?? "");
    setPortMap(m?.portMap ?? "");
    setScheme(m?.scheme ?? "http");
    setIndexPath(m?.indexPath ?? "/");
    setTagline(m?.tagline ?? "");
  }, [m?.title, m?.icon, m?.portMap, m?.scheme, m?.indexPath, m?.tagline]);

  const handleSave = async () => {
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/docker/stacks/${encodeURIComponent(stack.name)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title:     title     || null,
          icon:      icon      || null,
          portMap:   portMap   || null,
          scheme:    scheme    || null,
          indexPath: indexPath || null,
          tagline:   tagline   || null,
        }),
      });
      if (!res.ok) {
        const d = await res.json() as { error?: string };
        setError(d.error ?? `Server error ${res.status}`);
        return;
      }
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      title={`Edit — ${stack.name}`}
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors">
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={busy}
            className="px-4 py-2 text-sm bg-amber-500 hover:bg-amber-400 text-black font-semibold rounded-lg transition-colors disabled:opacity-50"
          >
            {busy ? "Saving…" : "Save"}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Title" value={title} onChange={setTitle} placeholder={stack.name} />
        <Field label="Icon URL" value={icon} onChange={setIcon} placeholder="https://…/icon.png" />
        <Field label="Tagline" value={tagline} onChange={setTagline} placeholder="Short description" />
        <Field label="Port" value={portMap} onChange={setPortMap} placeholder="8096" type="number" />
        <div>
          <label className="block text-xs text-gray-500 mb-1">Scheme</label>
          <select
            value={scheme}
            onChange={(e) => setScheme(e.target.value)}
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-amber-500"
          >
            <option value="http">http</option>
            <option value="https">https</option>
          </select>
        </div>
        <Field label="Index path" value={indexPath} onChange={setIndexPath} placeholder="/" />
        {error && (
          <p className="text-red-400 text-xs bg-red-500/10 border border-red-500/20 rounded-lg p-2">{error}</p>
        )}
      </div>
    </Dialog>
  );
}

function Field({ label, value, onChange, placeholder, type = "text" }: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
}) {
  return (
    <div>
      <label className="block text-xs text-gray-500 mb-1">{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-amber-500"
      />
    </div>
  );
}

// ─── Note dialog ──────────────────────────────────────────────────────────────

function NoteDialog({ stack, open, onClose, onSaved }: {
  stack: Stack;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [text, setText] = useState(stack.meta?.note ?? "");
  const [busy,  setBusy]  = useState(false);
  const [error, setError] = useState("");

  useEffect(() => { setText(stack.meta?.note ?? ""); }, [stack.meta?.note]);

  const handleSave = async () => {
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/docker/stacks/${encodeURIComponent(stack.name)}`, {
        method:  "PATCH",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ note: text || null }),
      });
      if (!res.ok) {
        const d = await res.json() as { error?: string };
        setError(d.error ?? `Server error ${res.status}`);
        return;
      }
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      title={`Note — ${stack.meta?.title ?? stack.name}`}
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors">
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={busy}
            className="px-4 py-2 text-sm bg-amber-500 hover:bg-amber-400 text-black font-semibold rounded-lg transition-colors disabled:opacity-50"
          >
            {busy ? "Saving…" : "Save"}
          </button>
        </>
      }
    >
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Add a note about this stack…"
        rows={10}
        className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 font-mono focus:outline-none focus:border-amber-500 resize-y"
      />
      {error && (
        <p className="text-red-400 text-xs bg-red-500/10 border border-red-500/20 rounded-lg p-2 mt-2">{error}</p>
      )}
    </Dialog>
  );
}

// ─── Stack tile ───────────────────────────────────────────────────────────────

type StackAction = "start" | "stop" | "restart" | "logs" | "edit" | "note" | "casaos-import";

interface TileMenuProps {
  stack: Stack;
  onAction: (action: StackAction) => void;
  onClose: () => void;
}

function TileMenu({ stack, onAction, onClose }: TileMenuProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [onClose]);

  const allRunning = stack.state === "running";
  const allStopped = stack.state === "stopped";

  const act = (a: StackAction) => { onAction(a); onClose(); };

  return (
    <div
      ref={ref}
      className="absolute top-8 right-0 z-20 w-44 bg-gray-800 border border-gray-700 rounded-xl shadow-2xl py-1 text-sm"
    >
      {!allRunning && (
        <button className="w-full text-left px-4 py-2 hover:bg-gray-700 text-gray-200" onClick={() => act("start")}>Start</button>
      )}
      {!allStopped && (
        <button className="w-full text-left px-4 py-2 hover:bg-gray-700 text-gray-200" onClick={() => act("stop")}>Stop</button>
      )}
      <button className="w-full text-left px-4 py-2 hover:bg-gray-700 text-gray-200" onClick={() => act("restart")}>Restart</button>
      <div className="border-t border-gray-700 my-1" />
      <button className="w-full text-left px-4 py-2 hover:bg-gray-700 text-gray-200" onClick={() => act("logs")}>View Logs</button>
      <button className="w-full text-left px-4 py-2 hover:bg-gray-700 text-gray-200" onClick={() => act("note")}>
        Note {stack.meta?.note ? <span className="ml-1 text-amber-400">●</span> : null}
      </button>
      <button className="w-full text-left px-4 py-2 hover:bg-gray-700 text-gray-200" onClick={() => act("edit")}>Edit Info</button>
      <button className="w-full text-left px-4 py-2 hover:bg-gray-700 text-gray-400 text-xs" onClick={() => act("casaos-import")}>Import from CasaOS</button>
    </div>
  );
}

interface StackTileProps {
  stack: Stack;
  actionLoading: boolean;
  onAction: (action: StackAction) => void;
}

function StackTile({ stack, actionLoading, onAction }: StackTileProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const launchUrl = buildLaunchUrl(stack);
  const title     = stack.meta?.title ?? stack.name;
  const icon      = stack.meta?.icon ?? stack.icon ?? null;
  const tagline   = stack.meta?.tagline ?? null;
  const initial   = stack.name.charAt(0).toUpperCase();

  const handleClick = () => {
    if (launchUrl) window.open(launchUrl, "_blank", "noopener");
  };

  return (
    <div className="relative group">
      <div
        onClick={handleClick}
        className={`bg-gray-900 border border-gray-800 rounded-2xl p-5 flex flex-col items-center gap-3 transition-all select-none
          ${launchUrl ? "cursor-pointer hover:border-gray-600 hover:bg-gray-800/60 hover:scale-[1.02]" : "cursor-default"}
          ${actionLoading ? "opacity-40 pointer-events-none" : ""}`}
      >
        {/* Icon */}
        <div className="w-16 h-16 rounded-2xl bg-gray-800 border border-gray-700 flex items-center justify-center overflow-hidden">
          {icon
            ? <img src={icon} alt={title} className="w-full h-full object-contain p-1" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
            : <span className="text-3xl font-bold text-gray-200">{initial}</span>
          }
        </div>

        {/* Info */}
        <div className="w-full text-center space-y-1">
          <p className="text-sm text-gray-100 font-medium truncate">{title}</p>
          {tagline && <p className="text-[10px] text-gray-500 truncate">{tagline}</p>}
          <div className="flex items-center justify-center gap-1.5">
            <span className={`w-2 h-2 rounded-full ${stackStateColor[stack.state]}`} />
            <span className="text-xs text-gray-500">{stack.state}</span>
          </div>
          <p className="text-[10px] text-gray-600">
            {stack.services.length === 1 ? "1 service" : `${stack.services.length} services`}
            {launchUrl ? ` · ${stack.meta?.portMap ?? ""}` : ""}
          </p>
        </div>
      </div>

      <button
        className="absolute top-2 right-2 text-gray-600 hover:text-gray-200 opacity-0 group-hover:opacity-100 transition-opacity w-6 h-6 flex items-center justify-center rounded-lg hover:bg-gray-700"
        onClick={(e) => { e.stopPropagation(); setMenuOpen((v) => !v); }}
        aria-label="More options"
      >
        ⋮
      </button>

      {menuOpen && (
        <TileMenu stack={stack} onAction={onAction} onClose={() => setMenuOpen(false)} />
      )}
    </div>
  );
}

// ─── New Stack dialog ─────────────────────────────────────────────────────────

const NAME_RE = /^[a-zA-Z0-9_-]+$/;

function NewStackDialog({ open, onClose, onInstalled }: {
  open: boolean;
  onClose: () => void;
  onInstalled: () => void;
}) {
  const [name,    setName]    = useState("");
  const [content, setContent] = useState("");
  const [busy,    setBusy]    = useState(false);
  const [error,   setError]   = useState("");

  const reset = () => { setName(""); setContent(""); setError(""); setBusy(false); };
  const handleClose = () => { reset(); onClose(); };

  const handleInstall = async () => {
    if (!NAME_RE.test(name)) { setError("Name must be alphanumeric with dashes or underscores only."); return; }
    if (!content.trim())     { setError("Compose content cannot be empty."); return; }
    setBusy(true);
    setError("");
    try {
      const res  = await fetch("/api/compose/stacks", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ name, content }),
      });
      const data = await res.json() as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        setError(data.error ?? `Server error ${res.status}`);
      } else {
        reset();
        onInstalled();
        onClose();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      title="New Stack"
      onClose={handleClose}
      footer={
        <>
          <button
            onClick={handleClose}
            className="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleInstall}
            disabled={busy}
            className="px-4 py-2 text-sm bg-amber-500 hover:bg-amber-400 text-black font-semibold rounded-lg transition-colors disabled:opacity-50"
          >
            {busy ? "Installing…" : "Install"}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <label className="block text-sm text-gray-400 mb-1">Stack name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="my-stack"
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-amber-500"
          />
        </div>
        <div>
          <label className="block text-sm text-gray-400 mb-1">docker-compose.yml</label>
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder={"services:\n  myservice:\n    image: …"}
            rows={15}
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 font-mono focus:outline-none focus:border-amber-500 resize-y"
          />
        </div>
        {error && (
          <p className="text-red-400 text-sm bg-red-500/10 border border-red-500/20 rounded-lg p-3 whitespace-pre-wrap">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}

// ─── Home page ────────────────────────────────────────────────────────────────

export function HomePage({ username, onLogout, onNavigate }: {
  username: string;
  onLogout: () => void;
  onNavigate: (path: string) => void;
}) {
  const [stacks,       setStacks]       = useState<Stack[]>([]);
  const [stats,        setStats]        = useState<SystemStats | null>(null);
  const [version,      setVersion]      = useState("…");
  const [newStackOpen, setNewStackOpen] = useState(false);
  const [logsFor,      setLogsFor]      = useState<Stack | null>(null);
  const [logText,      setLogText]      = useState("");
  const [logsLoading,  setLogsLoading]  = useState(false);
  const [actionBusy,   setActionBusy]   = useState<string | null>(null);
  const [editStack,    setEditStack]    = useState<Stack | null>(null);
  const [noteStack,    setNoteStack]    = useState<Stack | null>(null);

  const loadStacks = useCallback(async () => {
    const res = await fetch("/api/docker/stacks");
    if (!res.ok) return;
    setStacks(await res.json() as Stack[]);
  }, []);

  const loadStats = useCallback(async () => {
    const res = await fetch("/api/system/stats");
    if (!res.ok) return;
    setStats(await res.json() as SystemStats);
  }, []);

  useEffect(() => {
    void loadStacks();
    void loadStats();
    fetch("/api/system/info")
      .then((r) => r.json())
      .then((d: unknown) => { if (d && typeof d === "object" && "version" in d) setVersion(String((d as { version: unknown }).version)); })
      .catch(() => {});
    const id = setInterval(() => { void loadStacks(); void loadStats(); }, 30_000);
    return () => clearInterval(id);
  }, [loadStacks, loadStats]);

  const openLogs = async (stack: Stack) => {
    setLogsFor(stack);
    setLogText("");
    setLogsLoading(true);
    try {
      const target = stack.services.find((s) => s.state === "running") ?? stack.services[0];
      if (!target) { setLogText("(no services)"); return; }
      const res  = await fetch(`/api/docker/containers/${target.id}/logs?tail=100`);
      const data = await res.json() as { logs?: string; error?: string };
      setLogText(data.logs ?? data.error ?? "(empty)");
    } finally {
      setLogsLoading(false);
    }
  };

  const importCasaos = async (stack: Stack) => {
    setActionBusy(stack.name);
    try {
      const res = await fetch(`/api/casaos/import/${encodeURIComponent(stack.name)}`, { method: "POST" });
      if (res.ok) await loadStacks();
    } finally {
      setActionBusy(null);
    }
  };

  const stackAction = async (stack: Stack, action: StackAction) => {
    if (action === "logs")          { await openLogs(stack);    return; }
    if (action === "edit")          { setEditStack(stack);      return; }
    if (action === "note")          { setNoteStack(stack);      return; }
    if (action === "casaos-import") { await importCasaos(stack); return; }
    setActionBusy(stack.name);
    try {
      await Promise.all(
        stack.services.map((s) => fetch(`/api/docker/containers/${s.id}/${action}`, { method: "POST" }))
      );
      await loadStacks();
    } finally {
      setActionBusy(null);
    }
  };

  return (
    <div className="h-screen bg-gray-950 text-white flex flex-col overflow-hidden">

      {/* ── Top bar ── */}
      <TopBar username={username} version={version} onLogout={onLogout} />

      {/* ── Main area ── */}
      <div className="flex-1 flex overflow-hidden">

        {/* ── Left panel ── */}
        <aside className="w-60 border-r border-gray-800 p-4 flex flex-col gap-3 overflow-y-auto shrink-0">
          <ClockWidget />
          <CalendarWidget />
          <SystemWidget stats={stats} />
          <NetworkWidget />
        </aside>

        {/* ── Right panel — apps ── */}
        <main className="flex-1 p-6 overflow-y-auto">
          <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-4">

            {/* Files tile */}
            <div
              onClick={() => onNavigate("/files")}
              className="bg-gray-900 border border-dashed border-gray-700 rounded-2xl p-5 flex flex-col items-center gap-3 cursor-pointer hover:border-amber-500/50 hover:bg-gray-800/50 hover:scale-[1.02] transition-all select-none"
            >
              <div className="w-16 h-16 rounded-2xl bg-gray-800 border border-gray-700 flex items-center justify-center text-4xl">
                📁
              </div>
              <div className="text-center">
                <p className="text-sm text-gray-200 font-medium">Files</p>
                <p className="text-xs text-gray-600 mt-0.5">File manager</p>
              </div>
            </div>

            {/* New Stack tile */}
            <div
              onClick={() => setNewStackOpen(true)}
              className="bg-gray-900 border border-dashed border-gray-700 rounded-2xl p-5 flex flex-col items-center gap-3 cursor-pointer hover:border-amber-500/50 hover:bg-gray-800/50 hover:scale-[1.02] transition-all select-none"
            >
              <div className="w-16 h-16 rounded-2xl bg-gray-800 border border-gray-700 flex items-center justify-center text-4xl font-light text-amber-400">
                +
              </div>
              <div className="text-center">
                <p className="text-sm text-gray-200 font-medium">New Stack</p>
                <p className="text-xs text-gray-600 mt-0.5">Docker Compose</p>
              </div>
            </div>

            {stacks.map((s) => (
              <StackTile
                key={s.name}
                stack={s}
                actionLoading={actionBusy === s.name}
                onAction={(action) => void stackAction(s, action)}
              />
            ))}
          </div>
        </main>
      </div>

      {/* ── Bottom bar ── */}
      <BottomBar stacks={stacks} />

      {/* ── Dialogs / drawers ── */}
      <NewStackDialog
        open={newStackOpen}
        onClose={() => setNewStackOpen(false)}
        onInstalled={() => void loadStacks()}
      />

      {editStack && (
        <EditMetaDialog
          stack={editStack}
          open={editStack !== null}
          onClose={() => setEditStack(null)}
          onSaved={() => { void loadStacks(); }}
        />
      )}

      {noteStack && (
        <NoteDialog
          stack={noteStack}
          open={noteStack !== null}
          onClose={() => setNoteStack(null)}
          onSaved={() => { void loadStacks(); }}
        />
      )}

      <Drawer
        open={logsFor !== null}
        title={logsFor ? `Logs — ${logsFor.name}` : "Logs"}
        onClose={() => setLogsFor(null)}
      >
        {logsLoading
          ? <p className="text-gray-500 text-sm">Loading…</p>
          : <LogViewer logs={logText} className="h-full min-h-[60vh]" />
        }
      </Drawer>
    </div>
  );
}
