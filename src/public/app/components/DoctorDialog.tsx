import { useState, useEffect } from "react";
import {
  CheckCircle, XCircle, Loader2, RefreshCw, AlertCircle,
  ShieldCheck, ShieldAlert, User, Terminal, FolderOpen, ChevronRight,
} from "lucide-react";
import { Dialog } from "./Dialog";
import { api } from "../lib/api";
import { useSystemStore } from "../stores/systemStore";
import { ComposeSourcesDialog } from "./ComposeSourcesDialog";

// ─── Types ────────────────────────────────────────────────────────────────────

type CheckStatus = "pending" | "ok" | "warn" | "error";

interface Check {
  label: string;
  detail: string;
  status: CheckStatus;
}

import type { ToolInfo } from "../stores/systemStore";

interface EnvInfo {
  user:   string;
  uid:    number;
  isRoot: boolean;
  /**
   * `installed` means a server anpan-os can actually configure, not merely a binary named
   * smbd — see detectSamba() on the server. `flavor` says which one was found.
   */
  samba:  {
    installed: boolean;
    active:    boolean;
    enabled:   boolean;
    flavor?:   "samba" | "apple" | "none";
    reason?:   string;
  };
}

// ─── Initial state ────────────────────────────────────────────────────────────

const INITIAL_CHECKS: Check[] = [
  { label: "API",           detail: "Connecting…",  status: "pending" },
  { label: "Docker daemon", detail: "Connecting…",  status: "pending" },
  { label: "System stats",  detail: "Reading…",     status: "pending" },
  { label: "Stacks",        detail: "Counting…",    status: "pending" },
  { label: "Samba install", detail: "Checking…",    status: "pending" },
  { label: "Samba service", detail: "Checking…",    status: "pending" },
  { label: "Compose paths", detail: "Checking…",    status: "pending" },
];

// ─── Check runners ────────────────────────────────────────────────────────────

async function runServiceChecks(set: (i: number, patch: Partial<Check>) => void) {
  // Check 0: API
  try {
    const { data, error } = await api.api.system.info.get();
    if (error || !data) throw new Error("No response");
    const version = (data as { version?: string }).version ?? "?";
    set(0, { status: "ok", detail: `v${version}` });
  } catch {
    set(0, { status: "error", detail: "Could not reach API" });
  }

  // Check 1 + 3: Docker + stacks
  try {
    const { data, error } = await api.api.docker.stacks.get();
    if (error) throw new Error(String(error.status));
    const stacks  = Array.isArray(data) ? data as { state: string }[] : [];
    const running = stacks.filter(s => s.state === "running").length;
    set(1, { status: "ok", detail: `Daemon reachable · ${stacks.length} stack${stacks.length !== 1 ? "s" : ""}` });
    set(3, { status: "ok", detail: `${running} running · ${stacks.length - running} stopped` });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Docker unavailable";
    set(1, { status: "error", detail: msg });
    set(3, { status: "error", detail: "Docker unavailable" });
  }

  // Check 2: System stats
  try {
    const { data, error } = await api.api.system.stats.get();
    if (error || !data) throw new Error("No stats");
    const d = data as { cpu?: number; ramUsed?: number; ramTotal?: number };
    const ramPct = d.ramTotal ? Math.round(((d.ramUsed ?? 0) / d.ramTotal) * 100) : 0;
    set(2, { status: ramPct > 90 ? "warn" : "ok", detail: `CPU ${d.cpu ?? "?"}% · RAM ${ramPct}%` });
  } catch {
    set(2, { status: "error", detail: "Could not read stats" });
  }
}

/**
 * Check 6: whether every stack's containers agree with the managed compose file.
 *
 * Reports only — repairing recreates containers, so it lives behind the Compose Sources
 * dialog this row links to.
 */
async function runComposeSourceCheck(set: (i: number, patch: Partial<Check>) => void) {
  try {
    const { data, error } = await api.api.compose["compose-sources"].get({ query: {} });
    if (error) throw new Error(String(error.status));
    const stacks = (data as { stacks?: unknown[] } | null)?.stacks ?? [];
    set(6, stacks.length === 0
      ? { status: "ok",   detail: "All stacks point at the managed folder" }
      : { status: "error", detail: `${stacks.length} stack${stacks.length !== 1 ? "s" : ""} drifted — click to review` });
  } catch {
    set(6, { status: "warn", detail: "Could not check compose paths" });
  }
}

function applySambaChecks(env: EnvInfo, set: (i: number, patch: Partial<Check>) => void) {
  // macOS has an smbd — Apple's — that ignores smb.conf entirely. Saying "not found on
  // PATH" there would be plainly wrong and would send the user looking for a missing
  // binary that is sitting in /usr/sbin.
  if (env.samba.flavor === "apple") {
    set(4, { status: "warn", detail: "Apple SMB server — does not read smb.conf" });
    set(5, { status: "warn", detail: "Shares are managed in System Settings, or install Samba: brew install samba" });
    return;
  }

  if (!env.samba.installed) {
    set(4, { status: "warn", detail: "smbd not found on PATH" });
    set(5, { status: "warn", detail: "N/A — Samba not installed" });
  } else {
    set(4, { status: "ok", detail: "smbd binary found" });
    set(5, {
      status: env.samba.active ? "ok" : "error",
      detail: env.samba.active
        ? `Active${env.samba.enabled ? " · enabled" : " · not enabled at boot"}`
        : `Inactive${env.samba.enabled ? " · enabled at boot" : " · disabled"}`,
    });
  }
}

// ─── Row components ───────────────────────────────────────────────────────────

function statusIcon(status: CheckStatus) {
  return {
    pending: <Loader2    size={14} className="animate-spin text-gray-500" />,
    ok:      <CheckCircle size={14} className="text-green-400" />,
    warn:    <AlertCircle size={14} className="text-yellow-400" />,
    error:   <XCircle    size={14} className="text-red-400" />,
  }[status];
}

function CheckRow({ check, onClick }: { check: Check; onClick?: () => void }) {
  const labelColor = {
    pending: "text-gray-400",
    ok:      "text-gray-200",
    warn:    "text-yellow-200",
    error:   "text-red-300",
  }[check.status];

  const body = (
    <>
      <span className="shrink-0">{statusIcon(check.status)}</span>
      <span className={`text-sm font-medium w-32 shrink-0 ${labelColor}`}>{check.label}</span>
      <span className="text-xs text-gray-500 truncate">{check.detail}</span>
      {onClick && <ChevronRight size={13} className="ml-auto shrink-0 text-gray-600" />}
    </>
  );

  const cls = "flex items-center gap-3 py-2.5 border-b border-gray-800/50 last:border-0";

  return onClick ? (
    <button onClick={onClick} className={`${cls} w-full text-left hover:bg-gray-900/60 transition-colors`}>
      {body}
    </button>
  ) : (
    <div className={cls}>{body}</div>
  );
}

function ToolRow({ tool }: { tool: ToolInfo }) {
  const na = tool.binary === undefined;
  return (
    <div className={`py-2 border-b border-gray-800/50 last:border-0 ${na ? "opacity-40" : ""}`}>
      <div className="flex items-center gap-2.5">
        <span className="shrink-0">
          {na ? <span className="w-3.5 h-3.5 inline-block" /> :
           tool.available
            ? <CheckCircle size={14} className="text-green-400" />
            : <XCircle    size={14} className="text-red-400" />}
        </span>
        <span className={`text-sm font-medium w-20 shrink-0 ${tool.available || na ? "text-gray-200" : "text-red-300"}`}>
          {tool.name}
        </span>
        <span className="text-xs text-gray-600 truncate flex-1">{tool.feature}</span>
        {tool.binary && (
          <code className="text-[10px] font-mono text-gray-700 shrink-0">{tool.binary}</code>
        )}
      </div>
      {tool.binary && !tool.available && (
        <p className="ml-6 mt-0.5 text-[10px] text-yellow-700 leading-snug">{tool.installHint}</p>
      )}
    </div>
  );
}

// ─── Section label ────────────────────────────────────────────────────────────

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-[10px] font-semibold text-gray-600 uppercase tracking-widest mb-2">{label}</p>
      <div className="bg-gray-950 border border-gray-800 rounded-xl px-4">
        {children}
      </div>
    </div>
  );
}

// ─── Main dialog ──────────────────────────────────────────────────────────────

export function DoctorDialog({ open, onClose }: {
  open: boolean;
  onClose: () => void;
}) {
  const systemStore = useSystemStore();

  const [checks,    setChecks]    = useState<Check[]>(INITIAL_CHECKS);
  const [running,   setRunning]   = useState(false);
  const [configDir, setConfigDir] = useState<string | null>(null);
  const [sourcesOpen, setSourcesOpen] = useState(false);

  const setCheck = (i: number, patch: Partial<Check>) =>
    setChecks(prev => prev.map((c, idx) => (idx === i ? { ...c, ...patch } : c)));

  const run = async () => {
    setRunning(true);
    setChecks(INITIAL_CHECKS);
    setConfigDir(null);

    await Promise.all([
      runComposeSourceCheck(setCheck),
      runServiceChecks(setCheck).then(async () => {
        // piggyback configDir from the info response
        try {
          const { data } = await api.api.system.info.get();
          const d = data as { version?: string; configDir?: string } | null;
          setConfigDir(d?.configDir ?? null);
        } catch { /* ignore */ }
      }),
      // reload() fetches env + tools in one shot and updates the store
      systemStore.reload().then(() => {
        api.api.system.environment.get().then(({ data }) => {
          if (data && typeof data === "object" && "samba" in data)
            applySambaChecks(data as EnvInfo, setCheck);
        }).catch(() => {
          setCheck(4, { status: "error", detail: "Could not check" });
          setCheck(5, { status: "error", detail: "Could not check" });
        });
      }),
    ]);

    setRunning(false);
  };

  useEffect(() => {
    if (open) void run();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const serviceChecks = checks.slice(0, 4);
  const sambaChecks   = checks.slice(4, 6);
  const composeCheck  = checks[6];
  const tools         = systemStore.tools;
  const toolsLoaded   = systemStore.loaded;

  const allOk  = checks.every(c => c.status === "ok");
  const hasErr = checks.some(c => c.status === "error");

  const summary = running
    ? null
    : allOk  ? { text: "All systems operational", color: "text-green-400",  bg: "bg-green-500/10  border-green-500/20"  }
    : hasErr ? { text: "Issues detected",          color: "text-red-400",    bg: "bg-red-500/10    border-red-500/20"    }
    :          { text: "Check warnings above",     color: "text-yellow-400", bg: "bg-yellow-500/10 border-yellow-500/20" };

  // `applicable` excludes tools with no role on this platform — systemctl and ss on macOS,
  // lsof and launchctl on Linux — which are absent by design rather than missing.
  const toolsMissing = tools.filter(t => t.applicable !== false && !t.available).length;

  return (
    <>
    <Dialog open={open} title="System Doctor" disableBackdropClose onClose={onClose} size="lg"
      footer={
        <button onClick={run} disabled={running}
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs text-gray-400 hover:text-white hover:bg-gray-800 transition-colors disabled:opacity-40"
        >
          <RefreshCw size={13} className={running ? "animate-spin" : ""} />
          Re-run
        </button>
      }
    >
      <div className="grid grid-cols-2 gap-4">

        {/* ── Left column ── */}
        <div className="space-y-4">

          {/* System info */}
          <Section label="Process">
            {!systemStore.loaded ? (
              <div className="flex items-center gap-2 py-3 text-xs text-gray-600">
                <Loader2 size={13} className="animate-spin" /> Loading…
              </div>
            ) : (
              <div className="py-3 space-y-2">
                <div className="flex items-center gap-2.5">
                  <User size={13} className="text-gray-500 shrink-0" />
                  <span className="text-xs text-gray-400 w-16 shrink-0">User</span>
                  <code className="text-xs font-mono text-gray-200">{systemStore.user}</code>
                  <span className="text-[10px] text-gray-600 font-mono">(uid {systemStore.uid})</span>
                </div>
                <div className="flex items-center gap-2.5">
                  {systemStore.isRoot
                    ? <ShieldCheck size={13} className="text-amber-400 shrink-0" />
                    : <ShieldAlert size={13} className="text-gray-600 shrink-0" />}
                  <span className="text-xs text-gray-400 w-16 shrink-0">Privilege</span>
                  {systemStore.isRoot
                    ? <span className="text-xs font-medium text-amber-400">Root / elevated</span>
                    : <span className="text-xs text-gray-500">Standard user — some features may be restricted</span>}
                </div>
                {configDir && (
                  <div className="flex items-center gap-2.5">
                    <FolderOpen size={13} className="text-gray-500 shrink-0" />
                    <span className="text-xs text-gray-400 w-16 shrink-0">Data dir</span>
                    <code className="text-xs font-mono text-gray-300 break-all">{configDir}</code>
                  </div>
                )}
              </div>
            )}
          </Section>

          {/* Services */}
          <Section label="Services">
            {serviceChecks.map((c, i) => <CheckRow key={i} check={c} />)}
          </Section>

          {/* Samba */}
          <Section label="Samba">
            {sambaChecks.map((c, i) => <CheckRow key={i} check={c} />)}
          </Section>

          {/* Compose sources — row opens the detail dialog where repair lives */}
          <Section label="Stacks">
            {composeCheck && (
              <CheckRow
                check={composeCheck}
                onClick={composeCheck.status === "pending" ? undefined : () => setSourcesOpen(true)}
              />
            )}
          </Section>

          {/* Summary */}
          {summary && (
            <div className={`px-4 py-2.5 rounded-xl border text-xs font-medium ${summary.color} ${summary.bg}`}>
              {summary.text}
            </div>
          )}

        </div>

        {/* ── Right column — External tools ── */}
        <div>
          <div className="flex items-center gap-1.5 mb-2">
            <Terminal size={10} className="text-gray-600" />
            <p className="text-[10px] font-semibold text-gray-600 uppercase tracking-widest">
              External tools
              {tools && toolsMissing > 0 && (
                <span className="ml-2 text-red-500 normal-case">{toolsMissing} missing</span>
              )}
            </p>
          </div>
          <div className="bg-gray-950 border border-gray-800 rounded-xl px-4">
            {!toolsLoaded || (running && tools.length === 0) ? (
              <div className="flex items-center gap-2 py-4 text-xs text-gray-600">
                <Loader2 size={13} className="animate-spin" /> Checking binaries…
              </div>
            ) : tools.length === 0 ? (
              <p className="py-4 text-xs text-gray-600">Could not load tool info.</p>
            ) : (
              tools.map(t => <ToolRow key={t.id} tool={t} />)
            )}
          </div>
        </div>

      </div>
    </Dialog>

    {/* Sibling, not nested: a fixed-position dialog inside the parent's scrollable
        body is subject to the parent's containing block and clipping. */}
    <ComposeSourcesDialog
      open={sourcesOpen}
      onClose={() => { setSourcesOpen(false); void runComposeSourceCheck(setCheck); }}
    />
    </>
  );
}
