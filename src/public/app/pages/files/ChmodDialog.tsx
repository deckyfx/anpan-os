import { useState, useEffect } from "react";
import { ShieldCheck } from "lucide-react";
import { Dialog } from "../../components/Dialog";
import { api } from "../../lib/api";
import { useSystemStore } from "../../stores/systemStore";
import type { FileEntry } from "./types";

// ─── Permission model ─────────────────────────────────────────────────────────

type PermLevel = "none" | "read" | "write";

interface PermState {
  owner: PermLevel;
  group: PermLevel;
  other: PermLevel;
  executable: boolean;
}

/** Parse a 3-char octal string (e.g. "755") into UI perm state. */
function parseMode(octal: string): PermState {
  const pad = octal.padStart(3, "0").slice(-3);
  const digits = pad.split("").map(c => parseInt(c, 10));

  const toLevel = (d: number): PermLevel => {
    if (d & 2) return "write";   // has write bit → write (implies read)
    if (d & 4) return "read";    // has read only
    return "none";
  };

  const [o = 0, g = 0, x = 0] = digits;
  return {
    owner:      toLevel(o),
    group:      toLevel(g),
    other:      toLevel(x),
    executable: !!(o & 1) || !!(g & 1) || !!(x & 1),
  };
}

/** Compute octal mode string from UI perm state. */
function buildMode(p: PermState): string {
  const toDigit = (level: PermLevel): number => {
    const base = level === "write" ? 6 : level === "read" ? 4 : 0;
    return base + (p.executable ? 1 : 0);
  };
  const o = toDigit(p.owner);
  const g = toDigit(p.group);
  const x = toDigit(p.other);
  return `${o}${g}${x}`;
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function PermRow({ label, value, onChange }: {
  label: string;
  value: PermLevel;
  onChange: (v: PermLevel) => void;
}) {
  const opts: { v: PermLevel; label: string }[] = [
    { v: "none",  label: "None"  },
    { v: "read",  label: "Read"  },
    { v: "write", label: "Write" },
  ];
  return (
    <div className="flex items-center gap-4">
      <span className="w-14 text-xs text-gray-400 shrink-0">{label}</span>
      <div className="flex items-center gap-5">
        {opts.map(({ v, label: lbl }) => (
          <label key={v} className="flex items-center gap-1.5 cursor-pointer select-none">
            <input
              type="radio"
              name={`perm-${label}`}
              checked={value === v}
              onChange={() => onChange(v)}
              className="accent-blue-500"
            />
            <span className={`text-xs ${value === v ? "text-white" : "text-gray-400"}`}>{lbl}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

function OwnerInput({ label, value, onChange, disabled, placeholder }: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
  placeholder: string;
}) {
  return (
    <div className="flex-1 min-w-0">
      <label className="block text-[10px] text-gray-500 mb-1 uppercase tracking-wider">{label}</label>
      <input
        type="text"
        value={value}
        onChange={e => onChange(e.target.value)}
        disabled={disabled}
        placeholder={placeholder}
        className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500 disabled:opacity-40 disabled:cursor-not-allowed font-mono"
      />
    </div>
  );
}

// ─── Symbolic display (rwxrwxrwx) ────────────────────────────────────────────

function SymbolicBits({ mode, isDir }: { mode: string; isDir: boolean }) {
  const octal = parseInt(mode, 8);
  const bits = [
    { bit: 0o400, char: "r" }, { bit: 0o200, char: "w" }, { bit: 0o100, char: "x" },
    { bit: 0o040, char: "r" }, { bit: 0o020, char: "w" }, { bit: 0o010, char: "x" },
    { bit: 0o004, char: "r" }, { bit: 0o002, char: "w" }, { bit: 0o001, char: "x" },
  ];
  return (
    <span className="font-mono text-xs tracking-widest">
      <span className="text-gray-600">{isDir ? "d" : "-"}</span>
      {bits.map(({ bit, char }, i) => (
        <span key={i} className={octal & bit ? "text-blue-400" : "text-gray-700"}>
          {octal & bit ? char : "-"}
        </span>
      ))}
    </span>
  );
}

// ─── Dialog inner ─────────────────────────────────────────────────────────────

function ChmodDialogInner({ entry, onClose, onApplied }: {
  entry: FileEntry;
  onClose: () => void;
  onApplied: () => void;
}) {
  const { isRoot } = useSystemStore();

  const [perm,      setPerm]      = useState<PermState>(() => parseMode(entry.mode));
  const [owner,     setOwner]     = useState(String(entry.uid));
  const [group,     setGroup]     = useState(String(entry.gid));
  const [recursive, setRecursive] = useState(false);
  const [busy,      setBusy]      = useState(false);
  const [error,     setError]     = useState("");

  // Re-parse if entry changes (e.g. dialog reused)
  useEffect(() => {
    setPerm(parseMode(entry.mode));
    setOwner(String(entry.uid));
    setGroup(String(entry.gid));
    setRecursive(false);
    setError("");
  }, [entry.path]);

  const computedMode = buildMode(perm);
  const ownerChanged = owner !== String(entry.uid);
  const groupChanged = group !== String(entry.gid);
  const modeChanged  = computedMode !== entry.mode.padStart(3, "0").slice(-3);

  const handleApply = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      if (modeChanged) {
        const { error: err } = await api.api.files.chmod.post({
          path: entry.path,
          mode: computedMode,
          recursive: recursive || undefined,
        });
        if (err) {
          setError((err.value as { error?: string })?.error ?? "chmod failed");
          return;
        }
      }
      if ((ownerChanged || groupChanged) && isRoot) {
        const { error: err } = await api.api.files.chown.post({
          path: entry.path,
          owner,
          group,
          recursive: recursive || undefined,
        });
        if (err) {
          setError((err.value as { error?: string })?.error ?? "chown failed");
          return;
        }
      }
      onApplied();
      onClose();
    } finally {
      setBusy(false);
    }
  };

  const footer = (
    <>
      <button onClick={onClose} className="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors">
        Cancel
      </button>
      <button
        onClick={() => void handleApply()}
        disabled={busy || (!modeChanged && !ownerChanged && !groupChanged)}
        className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 text-white font-semibold rounded-lg transition-colors disabled:opacity-40"
      >
        {busy ? "Applying…" : "Apply"}
      </button>
    </>
  );

  return (
    <Dialog open title={`Permissions — ${entry.name}`} onClose={onClose} footer={footer}>
      <div className="space-y-5">

        {/* Owner / Group */}
        <div className="grid grid-cols-2 gap-3">
          <OwnerInput
            label="Owner"
            value={owner}
            onChange={setOwner}
            disabled={!isRoot}
            placeholder={String(entry.uid)}
          />
          <OwnerInput
            label="Group"
            value={group}
            onChange={setGroup}
            disabled={!isRoot}
            placeholder={String(entry.gid)}
          />
        </div>
        {!isRoot && (
          <p className="text-[10px] text-gray-600 -mt-3">
            Owner/group change requires root privileges.
          </p>
        )}

        {/* Permission bits */}
        <div>
          <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-widest mb-3">Permissions</p>
          <div className="space-y-3">
            <PermRow label="Owner" value={perm.owner} onChange={v => setPerm(p => ({ ...p, owner: v }))} />
            <PermRow label="Group" value={perm.group} onChange={v => setPerm(p => ({ ...p, group: v }))} />
            <PermRow label="Other" value={perm.other} onChange={v => setPerm(p => ({ ...p, other: v }))} />
          </div>
        </div>

        {/* Executable + Recursive */}
        <div className="space-y-2">
          <label className="flex items-center gap-2.5 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={perm.executable}
              onChange={e => setPerm(p => ({ ...p, executable: e.target.checked }))}
              className="w-4 h-4 rounded accent-blue-500"
            />
            <span className="text-sm text-gray-300">Executable</span>
            <span className="text-xs text-gray-600">(adds execute bit for all classes)</span>
          </label>
          {entry.isDir && (
            <label className="flex items-center gap-2.5 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={recursive}
                onChange={e => setRecursive(e.target.checked)}
                className="w-4 h-4 rounded accent-blue-500"
              />
              <span className="text-sm text-gray-300">Recursive</span>
              <span className="text-xs text-gray-600">(apply to all files and subdirectories)</span>
            </label>
          )}
        </div>

        <p className="text-[10px] text-gray-600">
          Write-only is normalized to read+write. Executable applies to all classes equally.
        </p>

        {/* Live preview */}
        <div className="flex items-center justify-between bg-gray-800/60 rounded-lg px-4 py-2.5 border border-gray-700">
          <SymbolicBits mode={computedMode} isDir={entry.isDir} />
          <span className="font-mono text-sm text-gray-300">{computedMode}</span>
        </div>

        {error && (
          <p className="text-red-400 text-xs bg-red-500/10 border border-red-500/20 rounded-lg p-2">{error}</p>
        )}
      </div>
    </Dialog>
  );
}

// ─── Public export ────────────────────────────────────────────────────────────

export function ChmodDialog({ entry, open, onClose, onApplied }: {
  entry: FileEntry | null;
  open: boolean;
  onClose: () => void;
  onApplied: () => void;
}) {
  if (!open || !entry) return null;
  return <ChmodDialogInner key={entry.path} entry={entry} onClose={onClose} onApplied={onApplied} />;
}
