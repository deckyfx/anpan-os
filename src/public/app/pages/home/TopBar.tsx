import { useState, useRef, useEffect } from "react";
import { Menu, X, LayoutGrid, FolderOpen, Activity, Network, LogOut, KeyRound, RotateCcw, PowerOff, Lock, Container, ShoppingBag, RefreshCw, HardDrive } from "lucide-react";
import { api } from "../../lib/api";
import { DoctorDialog }   from "../../components/DoctorDialog";
import { DiskCleanupDialog } from "../../components/DiskCleanupDialog";
import { VersionDialog }  from "../../components/VersionDialog";
import { PortsDialog }    from "./PortsDialog";
import { ChangePasswordDialog } from "./ChangePasswordDialog";
import { DockerHubDialog } from "./DockerHubDialog";
import { browserSupportsWebAuthn } from "@simplewebauthn/browser";
import { useSystemStore } from "../../stores/systemStore";
import { useToastStore } from "../../stores/toastStore";
import { useAuthStore } from "../../stores/authStore";
import { UpdatesMenu } from "./UpdatesMenu";

interface NavItem {
  icon: React.ReactNode;
  label: string;
  path: string;
  section?: string;
  /** Open in a new tab instead of replacing the current page. */
  newTab?: boolean;
}

const MENU_ITEMS: NavItem[] = [
  { icon: <LayoutGrid   size={14} />, label: "Home",       path: "/",       section: "Navigation" },
  { icon: <FolderOpen   size={14} />, label: "Files",      path: "/files",  section: "Navigation", newTab: true },
  { icon: <ShoppingBag  size={14} />, label: "App Store",  path: "/store",  section: "Navigation" },
  { icon: <Activity     size={14} />, label: "Doctor",     path: "/doctor", section: "Tools"      },
  { icon: <Network      size={14} />, label: "Port Scan",  path: "/ports",  section: "Tools"      },
  { icon: <HardDrive    size={14} />, label: "Disk Cleanup", path: "/cleanup", section: "Tools"    },
];

/**
 * Renders the application's top navigation bar with branding, a contextual menu, and session controls.
 *
 * The menu lists navigation items grouped by section (items flagged `newTab` render as
 * links that open in a new tab), exposes system power actions when allowed,
 * provides actions for Docker Hub, password change, adding a passkey (when supported), and signing out,
 * and controls several modal dialogs (Doctor, Ports, Change Password, Docker Hub).
 *
 * @param username - Current user's display name
 * @param version - Application version string shown next to the branding
 * @param hasPasskey - `false` if the user has no passkey configured, `true` if configured, or `null` when unknown
 * @param onLogout - Callback invoked after the logout attempt completes
 * @param onNavigate - Callback invoked with a path when a navigation item or the branding button is activated
 * @param onAddPasskey - Async callback to add a passkey; errors are surfaced via toast notifications
 * @param currentPath - Current route path used to determine which menu item is active (defaults to "/")
 * @returns The header element containing the top bar and its managed dialogs
 */
export function TopBar({ username, version, hasPasskey, onLogout, onNavigate, onAddPasskey, currentPath = "/", showUpdates = true }: {
  username: string;
  version: string;
  hasPasskey: boolean | null;
  onLogout: () => void;
  onNavigate: (path: string) => void;
  onAddPasskey: () => Promise<void>;
  currentPath?: string;
  /** Docker image update checker. Off on pages that have nothing to do with stacks. */
  showUpdates?: boolean;
}) {
  const { isRoot, hasBin, platformLabel } = useSystemStore();

  // "macOS (Apple Silicon)" is more than the bar has room for; the parenthetical is the
  // part a glance does not need, and the full string stays in the tooltip.
  const shortOs = platformLabel.replace(/\s*\(.*\)\s*$/, "");
  const canPowerCtl = isRoot && hasBin("systemctl");
  const passkeyEnabled = useAuthStore(s => s.loginMethods.passkey);

  const [open, setOpen]                     = useState(false);
  const [pos,  setPos]                      = useState({ left: 0, top: 0 });
  const [doctorOpen, setDoctorOpen]         = useState(false);
  const [cleanupOpen, setCleanupOpen]       = useState(false);
  const [portsOpen,  setPortsOpen]          = useState(false);
  const [changePwOpen, setChangePwOpen]     = useState(false);
  const [dockerHubOpen, setDockerHubOpen]   = useState(false);
  const [versionOpen, setVersionOpen]       = useState(false);
  const [pkLoading, setPkLoading]   = useState(false);
  const [confirm, setConfirm]       = useState<"restart" | "shutdown" | null>(null);
  const btnRef  = useRef<HTMLButtonElement>(null);
  const dropRef = useRef<HTMLDivElement>(null);

  const toggle = () => {
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      setPos({ left: r.left, top: r.bottom + 6 });
    }
    if (open) setConfirm(null);
    setOpen(v => !v);
  };

  const handlePowerAction = async (action: "restart" | "shutdown") => {
    if (confirm !== action) { setConfirm(action); return; }
    setConfirm(null);
    setOpen(false);
    try {
      if (action === "restart")  await api.api.system.restart.post();
      if (action === "shutdown") await api.api.system.shutdown.post();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      useToastStore.getState().push(`Failed to ${action}: ${message}`, "error");
    }
  };

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (
        dropRef.current && !dropRef.current.contains(e.target as Node) &&
        btnRef.current  && !btnRef.current.contains(e.target as Node)
      ) { setOpen(false); setConfirm(null); }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const handleLogout = async () => {
    setOpen(false);
    try {
      await api.api.auth.logout.post();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      useToastStore.getState().push(`Logout failed: ${message}`, "error");
    } finally {
      onLogout();
    }
  };

  const navigate = (path: string) => {
    setOpen(false);
    if (path === "/doctor") {
      setDoctorOpen(true);
    } else if (path === "/cleanup") {
      setCleanupOpen(true);
    } else if (path === "/ports") {
      setPortsOpen(true);
    } else {
      onNavigate(path);
    }
  };

  // Hide the item for the current page (boundary-aware: "/files" must not match "/filesarchive")
  const isActive = (itemPath: string) =>
    itemPath === "/"
      ? currentPath === "/"
      : currentPath === itemPath || currentPath.startsWith(itemPath + "/");
  const visibleItems = MENU_ITEMS.filter(item => !isActive(item.path));

  // Group items by section
  const sections = visibleItems.reduce<Record<string, NavItem[]>>((acc, item) => {
    const key = item.section ?? "Other";
    (acc[key] ??= []).push(item);
    return acc;
  }, {});

  return (
    <>
    <header className="h-12 border-b border-gray-800 px-5 flex items-center gap-0 shrink-0 bg-gray-950">

      {/* Branding */}
      <button
        onClick={() => onNavigate("/")}
        className="flex items-center gap-2.5 shrink-0 rounded-lg px-1 py-0.5 hover:bg-gray-800 transition-colors"
        aria-label="Go to dashboard"
      >
        <span className="text-lg">🍞</span>
        <span className="font-bold text-amber-400 tracking-wide">anpan-os</span>
      </button>

      {/* Separator */}
      <div className="mx-3 h-5 w-px bg-gray-800 shrink-0" />

      {/* Menu button */}
      <button
        ref={btnRef}
        onClick={toggle}
        aria-haspopup="true"
        aria-expanded={open}
        aria-label="Menu"
        className={`flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg transition-colors ${
          open
            ? "bg-gray-800 text-white"
            : "text-gray-400 hover:text-white hover:bg-gray-800"
        }`}
      >
        {open ? <X size={14} /> : <Menu size={14} />}
        Menu
      </button>

      {/* Updates menu — Check all / View report */}
      {showUpdates && <UpdatesMenu />}

      {/* Version badge — far right */}
      <button
        onClick={() => setVersionOpen(true)}
        className="ml-auto text-xs text-gray-500 font-mono hover:text-gray-300 px-2 py-1 rounded-lg hover:bg-gray-800 transition-colors shrink-0"
        aria-label={`Show version and update info — anpan-os ${version}${shortOs ? ` on ${platformLabel}` : ""}${username ? `, signed in as ${username}` : ""}`}
        title={[platformLabel, username && `signed in as ${username}`, `v${version}`].filter(Boolean).join(" · ")}
      >
        {/* Host and account are context, not the subject — dimmer than the version, and
            the first to go when the bar runs out of room on a narrow screen. */}
        {shortOs && <span className="hidden md:inline text-gray-600">{shortOs}</span>}
        {shortOs && username && <span className="hidden md:inline text-gray-700"> · </span>}
        {username && <span className="hidden sm:inline text-gray-600">{username}</span>}
        {(shortOs || username) && <span className="hidden sm:inline text-gray-700"> · </span>}
        v{version}
      </button>

      {/* Dropdown — fixed, anchored via JS measurement */}
      {open && (
        <div
          ref={dropRef}
          role="menu"
          aria-label="Main menu"
          style={{ left: pos.left, top: pos.top }}
          className="fixed z-50 w-52 bg-gray-900 border border-gray-700 rounded-xl shadow-2xl py-2 overflow-hidden"
        >
          {Object.entries(sections).map(([section, items], si) => (
            <div key={section}>
              {si > 0 && <div className="my-1.5 border-t border-gray-800" />}
              <p className="text-[9px] font-semibold text-gray-600 uppercase tracking-widest px-3 py-1">{section}</p>
              {items.map(item => item.newTab ? (
                <a
                  key={item.path}
                  role="menuitem"
                  href={item.path}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => setOpen(false)}
                  className="w-full flex items-center gap-3 px-3 py-2 text-sm text-gray-300 hover:text-white hover:bg-gray-800 transition-colors text-left"
                >
                  <span className="text-gray-500">{item.icon}</span>
                  {item.label}
                </a>
              ) : (
                <button
                  key={item.path}
                  role="menuitem"
                  onClick={() => navigate(item.path)}
                  className="w-full flex items-center gap-3 px-3 py-2 text-sm text-gray-300 hover:text-white hover:bg-gray-800 transition-colors text-left"
                >
                  <span className="text-gray-500">{item.icon}</span>
                  {item.label}
                </button>
              ))}
            </div>
          ))}

          {canPowerCtl && (
            <div className="my-1.5 border-t border-gray-800">
              <p className="text-[9px] font-semibold text-gray-600 uppercase tracking-widest px-3 pt-2 pb-1">System</p>
              <button
                onClick={() => void handlePowerAction("restart")}
                className={`w-full flex items-center gap-3 px-3 py-2 text-sm transition-colors text-left ${
                  confirm === "restart"
                    ? "text-amber-400 bg-amber-500/10"
                    : "text-gray-300 hover:text-white hover:bg-gray-800"
                }`}
              >
                <RotateCcw size={14} className={confirm === "restart" ? "text-amber-400" : "text-gray-500"} />
                {confirm === "restart" ? "Confirm restart?" : "Restart"}
              </button>
              <button
                onClick={() => void handlePowerAction("shutdown")}
                className={`w-full flex items-center gap-3 px-3 py-2 text-sm transition-colors text-left ${
                  confirm === "shutdown"
                    ? "text-red-400 bg-red-500/10"
                    : "text-gray-300 hover:text-red-400 hover:bg-red-500/10"
                }`}
              >
                <PowerOff size={14} className={confirm === "shutdown" ? "text-red-400" : "text-gray-500"} />
                {confirm === "shutdown" ? "Confirm shutdown?" : "Shut down"}
              </button>
            </div>
          )}

          <div className="mt-1.5 border-t border-gray-800 pt-1.5">
            <button
              onClick={() => { setOpen(false); setDockerHubOpen(true); }}
              className="w-full flex items-center gap-3 px-3 py-2 text-sm text-gray-300 hover:text-white hover:bg-gray-800 transition-colors text-left"
            >
              <Container size={14} className="text-gray-500" />
              Docker Hub
            </button>
            <button
              onClick={() => { setOpen(false); setChangePwOpen(true); }}
              className="w-full flex items-center gap-3 px-3 py-2 text-sm text-gray-300 hover:text-white hover:bg-gray-800 transition-colors text-left"
            >
              <Lock size={14} className="text-gray-500" />
              Change password
            </button>
            {hasPasskey === false && browserSupportsWebAuthn() && passkeyEnabled && (
              <button
                onClick={async () => {
                  setPkLoading(true);
                  try {
                    await onAddPasskey();
                    setOpen(false);
                  } catch (e) {
                    const message = e instanceof Error ? e.message : String(e);
                    useToastStore.getState().push(`Failed to add passkey: ${message}`, "error");
                  } finally {
                    setPkLoading(false);
                  }
                }}
                disabled={pkLoading}
                className="w-full flex items-center gap-3 px-3 py-2 text-sm text-amber-400 hover:text-amber-300 hover:bg-amber-500/10 transition-colors text-left disabled:opacity-50"
              >
                {pkLoading
                  ? <span className="w-3.5 h-3.5 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />
                  : <KeyRound size={14} />}
                Add passkey
              </button>
            )}
            <button
              onClick={handleLogout}
              className="w-full flex items-center gap-3 px-3 py-2 text-sm text-gray-400 hover:text-red-400 hover:bg-red-500/10 transition-colors text-left"
            >
              <LogOut size={14} />
              Sign out
            </button>
          </div>
        </div>
      )}

    </header>

    <DoctorDialog    open={doctorOpen}    onClose={() => setDoctorOpen(false)}    />
    <DiskCleanupDialog open={cleanupOpen} onClose={() => setCleanupOpen(false)} />
    <PortsDialog     open={portsOpen}     onClose={() => setPortsOpen(false)}     />
    <ChangePasswordDialog open={changePwOpen}   onClose={() => setChangePwOpen(false)}   />
    <DockerHubDialog     open={dockerHubOpen}   onClose={() => setDockerHubOpen(false)}  />
    <VersionDialog   open={versionOpen}   onClose={() => setVersionOpen(false)}   version={version} />
    </>
  );
}
