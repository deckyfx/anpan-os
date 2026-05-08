import { useState } from "react";
import { ExternalLink } from "lucide-react";
import { Dialog } from "../../components/Dialog";
import type { ComposeOrigin, Stack } from "./types";
import { buildLaunchUrl, stackStateColor } from "./utils";
import { api } from "../../lib/api";

const ORIGIN_LABEL: Record<NonNullable<ComposeOrigin>, { label: string; cls: string }> = {
  managed: { label: "⚙ Managed by anpan-os", cls: "text-amber-400 bg-amber-500/10 border-amber-500/20" },
  casaos:  { label: "🏠 Managed by CasaOS",  cls: "text-sky-400  bg-sky-500/10  border-sky-500/20"  },
};

// ─── Inline field (compact variant for this dialog) ───────────────────────────

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

// ─── Tabs ─────────────────────────────────────────────────────────────────────

type DetailTab = "info" | "docker";

const DETAIL_TABS: { id: DetailTab; label: string }[] = [
  { id: "info",   label: "Stack Info" },
  { id: "docker", label: "Docker"     },
];

// ─── Inner component — keyed by stack.name so state initializes fresh each time ──

function StackDetailDialogInner({ stack, onClose, onSaved }: {
  stack: Stack;
  onClose: () => void;
  onSaved: () => void;
}) {
  const m = stack.meta;
  const launchUrl = buildLaunchUrl(stack);
  const [tab,       setTab]       = useState<DetailTab>("info");
  const [title,     setTitle]     = useState(m?.title     ?? "");
  const [icon,      setIcon]      = useState(m?.icon      ?? "");
  const [tagline,   setTagline]   = useState(m?.tagline   ?? "");
  const [address,   setAddress]   = useState(m?.address   ?? "");
  const [portMap,   setPortMap]   = useState(m?.portMap   ?? "");
  const [scheme,    setScheme]    = useState(m?.scheme    ?? "http");
  const [indexPath, setIndexPath] = useState(m?.indexPath ?? "/");
  const [note,      setNote]      = useState(m?.note      ?? "");
  const [busy,      setBusy]      = useState(false);
  const [saveError, setSaveError] = useState("");

  const handleSave = async () => {
    setBusy(true);
    setSaveError("");
    try {
      const { error: err } = await api.api.docker.stacks({ name: stack.name }).patch({
        title:     title     || null,
        icon:      icon      || null,
        tagline:   tagline   || null,
        address:   address   || null,
        portMap:   portMap   || null,
        scheme:    scheme    || null,
        indexPath: indexPath || null,
        note:      note      || null,
      });
      if (err) {
        setSaveError((err.value as { error?: string })?.error ?? "Server error");
        return;
      }
      onSaved();
      onClose();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const footer = tab === "info" ? (
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
  ) : (
    <button onClick={onClose} className="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors">
      Close
    </button>
  );

  return (
    <Dialog open title={m?.title ?? stack.name} onClose={onClose} size="xl" footer={footer}>
      {/* Tab bar */}
      <div className="flex gap-1 mb-5 border-b border-gray-800 -mt-1">
        {DETAIL_TABS.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors -mb-px
              ${tab === t.id
                ? "border-amber-500 text-amber-400"
                : "border-transparent text-gray-500 hover:text-gray-200"
              }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ── Stack Info ─────────────────────────────────────────────── */}
      {tab === "info" && (
        <div className="space-y-3">
          {launchUrl && (
            <a
              href={launchUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-sm text-amber-400 hover:text-amber-300 hover:underline"
            >
              <ExternalLink size={14} /> Open web UI — {launchUrl}
            </a>
          )}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Title"   value={title}   onChange={setTitle}   placeholder={stack.name} />
            <Field label="Tagline" value={tagline} onChange={setTagline} placeholder="Short description" />
          </div>
          <Field label="Icon URL" value={icon} onChange={setIcon} placeholder="https://…/icon.svg" />
          <div className="grid grid-cols-[auto_1fr] gap-3 items-end">
            <div>
              <label className="block text-xs text-gray-500 mb-1">Scheme</label>
              <select
                value={scheme}
                onChange={(e) => setScheme(e.target.value)}
                className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-amber-500"
              >
                <option value="http">http</option>
                <option value="https">https</option>
              </select>
            </div>
            <Field label="Address" value={address} onChange={setAddress} placeholder="e.g. npm.home.lan  (blank = current host)" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Port" value={portMap} onChange={setPortMap} placeholder="8096  (blank = default port)" />
            <Field label="Index path" value={indexPath} onChange={setIndexPath} placeholder="/" />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Note</label>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Add a note about this stack…"
              rows={5}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 font-mono focus:outline-none focus:border-amber-500 resize-y"
            />
          </div>
          {saveError && (
            <p className="text-red-400 text-xs bg-red-500/10 border border-red-500/20 rounded-lg p-2">{saveError}</p>
          )}
        </div>
      )}

      {/* ── Docker ─────────────────────────────────────────────────── */}
      {tab === "docker" && (
        <div className="space-y-4 text-sm">
          <div className="flex items-center gap-3">
            <span className="text-gray-500">Project name</span>
            <span className="font-mono text-gray-200">{stack.name}</span>
            <span className="ml-auto flex items-center gap-1.5 text-xs">
              <span className={`w-2 h-2 rounded-full ${stackStateColor[stack.state]}`} />
              <span className="text-gray-400">{stack.state}</span>
            </span>
          </div>

          {stack.origin && (() => {
            const o = ORIGIN_LABEL[stack.origin];
            return (
              <p className={`text-xs px-3 py-1.5 rounded-lg border ${o.cls}`}>{o.label}</p>
            );
          })()}
          {!stack.origin && (
            <p className="text-xs px-3 py-1.5 rounded-lg border border-gray-800 text-gray-600">
              No compose file found — discovered from Docker only
            </p>
          )}

          <div>
            <p className="text-xs text-gray-600 uppercase tracking-widest font-semibold mb-2">Services</p>
            <div className="overflow-x-auto rounded-lg border border-gray-800">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-gray-800 text-gray-600">
                    <th className="text-left px-3 py-2 font-medium">Service</th>
                    <th className="text-left px-3 py-2 font-medium">Image</th>
                    <th className="text-left px-3 py-2 font-medium">Container ID</th>
                    <th className="text-left px-3 py-2 font-medium">State</th>
                    <th className="text-left px-3 py-2 font-medium">Ports</th>
                  </tr>
                </thead>
                <tbody>
                  {stack.services.map(svc => (
                    <tr key={svc.id} className="border-b border-gray-800/50 last:border-0">
                      <td className="px-3 py-2 text-gray-200 font-medium">{svc.service}</td>
                      <td className="px-3 py-2 font-mono text-gray-400 max-w-48 truncate" title={svc.image}>{svc.image}</td>
                      <td className="px-3 py-2 font-mono text-gray-500">{svc.id.slice(0, 12)}</td>
                      <td className="px-3 py-2">
                        <span className="inline-flex items-center gap-1">
                          <span className={`w-1.5 h-1.5 rounded-full ${svc.state === "running" ? "bg-green-400" : "bg-red-400"}`} />
                          <span className="text-gray-400">{svc.state}</span>
                        </span>
                      </td>
                      <td className="px-3 py-2 text-gray-500 font-mono">
                        {svc.ports.filter(p => p.PublicPort).map(p => `${p.PublicPort}:${p.PrivatePort}/${p.Type ?? "tcp"}`).join(", ") || "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </Dialog>
  );
}

// ─── Public component — renders nothing when closed ──────────────────────────

export function StackDetailDialog({ stack, open, onClose, onSaved }: {
  stack: Stack;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  if (!open) return null;
  return <StackDetailDialogInner key={stack.name} stack={stack} onClose={onClose} onSaved={onSaved} />;
}
