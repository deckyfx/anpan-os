import { useState, useRef, useEffect } from "react";
import { Menu, X, LayoutGrid, FolderOpen, Activity, LogOut, KeyRound, RotateCcw, PowerOff, Lock } from "lucide-react";
import { api } from "../../lib/api";
import { DoctorDialog } from "../../components/DoctorDialog";
import { ChangePasswordDialog } from "./ChangePasswordDialog";
import { browserSupportsWebAuthn } from "@simplewebauthn/browser";
import { useSystemStore } from "../../stores/systemStore";
import { useToastStore } from "../../stores/toastStore";

interface NavItem {
  icon: React.ReactNode;
  label: string;
  path: string;
  section?: string;
}

const MENU_ITEMS: NavItem[] = [
  { icon: <LayoutGrid size={14} />, label: "Home",   path: "/",       section: "Navigation" },
  { icon: <FolderOpen  size={14} />, label: "Files",  path: "/files",  section: "Navigation" },
  { icon: <Activity    size={14} />, label: "Doctor", path: "/doctor", section: "Tools"      },
];

export function TopBar({ username, version, hasPasskey, onLogout, onNavigate, onAddPasskey, currentPath = "/" }: {
  username: string;
  version: string;
  hasPasskey: boolean | null;
  onLogout: () => void;
  onNavigate: (path: string) => void;
  onAddPasskey: () => Promise<void>;
  currentPath?: string;
}) {
  const { isRoot, hasBin } = useSystemStore();
  const canPowerCtl = isRoot && hasBin("systemctl");

  const [open, setOpen]             = useState(false);
  const [pos,  setPos]              = useState({ left: 0, top: 0 });
  const [doctorOpen, setDoctorOpen] = useState(false);
  const [changePwOpen, setChangePwOpen] = useState(false);
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
    await api.api.auth.logout.post();
    onLogout();
  };

  const navigate = (path: string) => {
    setOpen(false);
    if (path === "/doctor") {
      setDoctorOpen(true);
    } else {
      onNavigate(path);
    }
  };

  // Hide the item for the current page
  const visibleItems = MENU_ITEMS.filter(item =>
    item.path === "/" ? currentPath !== "/" : !currentPath.startsWith(item.path)
  );

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
      <div className="flex items-center gap-2.5 shrink-0">
        <span className="text-lg">🍞</span>
        <span className="font-bold text-amber-400 tracking-wide">anpan-os</span>
        <span className="text-xs text-gray-600 font-mono">v{version}</span>
      </div>

      {/* Separator */}
      <div className="mx-3 h-5 w-px bg-gray-800 shrink-0" />

      {/* Menu button */}
      <button
        ref={btnRef}
        onClick={toggle}
        className={`flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg transition-colors ${
          open
            ? "bg-gray-800 text-white"
            : "text-gray-400 hover:text-white hover:bg-gray-800"
        }`}
      >
        {open ? <X size={14} /> : <Menu size={14} />}
        Menu
      </button>

      {/* Dropdown — fixed, anchored via JS measurement */}
      {open && (
        <div
          ref={dropRef}
          style={{ left: pos.left, top: pos.top }}
          className="fixed w-52 bg-gray-900 border border-gray-700 rounded-xl shadow-2xl py-2 overflow-hidden"
        >
          {Object.entries(sections).map(([section, items], si) => (
            <div key={section}>
              {si > 0 && <div className="my-1.5 border-t border-gray-800" />}
              <p className="text-[9px] font-semibold text-gray-600 uppercase tracking-widest px-3 py-1">{section}</p>
              {items.map(item => (
                <button
                  key={item.path}
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
              onClick={() => { setOpen(false); setChangePwOpen(true); }}
              className="w-full flex items-center gap-3 px-3 py-2 text-sm text-gray-300 hover:text-white hover:bg-gray-800 transition-colors text-left"
            >
              <Lock size={14} className="text-gray-500" />
              Change password
            </button>
            {hasPasskey === false && browserSupportsWebAuthn() && (
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

    <DoctorDialog open={doctorOpen} onClose={() => setDoctorOpen(false)} />
    <ChangePasswordDialog open={changePwOpen} onClose={() => setChangePwOpen(false)} />
    </>
  );
}
