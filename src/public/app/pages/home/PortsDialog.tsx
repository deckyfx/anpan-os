import React, { useState, useEffect, useCallback } from "react";
import { RefreshCw, Pencil, Check, X } from "lucide-react";
import { Dialog } from "../../components/Dialog";
import { api }   from "../../lib/api";

interface PortEntry {
  port:      number;
  proto:     string;
  address:   string;
  process:   string;
  pid:       number | null;
  container: string | null;
  note:      string | null;
}

const PROTO_PILL: Record<string, string> = {
  tcp: "bg-sky-900 text-sky-300",
  udp: "bg-purple-900 text-purple-300",
};

function NoteCell({ entry, onSaved }: { entry: PortEntry; onSaved: (note: string | null) => void }) {
  const [editing, setEditing] = useState(false);
  const [value,   setValue]   = useState(entry.note ?? "");
  const [saving,  setSaving]  = useState(false);

  const key = encodeURIComponent(`${entry.port}/${entry.proto}`);

  const commit = async () => {
    setSaving(true);
    try {
      const trimmed = value.trim();
      if (trimmed) {
        await api.api.ports.notes({ key }).put({ note: trimmed });
        onSaved(trimmed);
      } else {
        await api.api.ports.notes({ key }).delete();
        onSaved(null);
      }
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  const cancel = () => { setValue(entry.note ?? ""); setEditing(false); };

  if (editing) {
    return (
      <div className="flex items-center gap-1.5">
        <input
          autoFocus
          value={value}
          onChange={e => setValue(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") void commit(); if (e.key === "Escape") cancel(); }}
          className="flex-1 min-w-0 bg-gray-800 border border-gray-600 focus:border-amber-500 rounded px-2 py-0.5 text-xs text-white outline-none"
          placeholder="Add a note…"
        />
        <button onClick={() => void commit()} disabled={saving} className="text-green-400 hover:text-green-300 disabled:opacity-50">
          <Check size={13} />
        </button>
        <button onClick={cancel} className="text-gray-500 hover:text-gray-300">
          <X size={13} />
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1.5 group/note">
      <span className={`flex-1 truncate text-xs ${entry.note ? "text-gray-300" : "text-gray-600 italic"}`}>
        {entry.note ?? "—"}
      </span>
      <button
        onClick={() => { setValue(entry.note ?? ""); setEditing(true); }}
        className="opacity-0 group-hover/note:opacity-100 text-gray-500 hover:text-amber-400 transition-opacity shrink-0"
      >
        <Pencil size={11} />
      </button>
    </div>
  );
}

export function PortsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [ports,   setPorts]   = useState<PortEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState<string | null>(null);
  const [filter,  setFilter]  = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data, error: err } = await api.api.ports.get();
      if (err) {
        setError((err as { value?: { error?: string } }).value?.error ?? "Failed to scan ports");
        return;
      }
      setPorts((data as PortEntry[]) ?? []);
    } finally {
      setLoading(false);
    }
  }, []);

  // Scan when dialog opens
  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const updateNote = (idx: number, note: string | null) => {
    setPorts(prev => prev.map((p, i) => i === idx ? { ...p, note } : p));
  };

  const q = filter.trim().toLowerCase();
  const displayed = q
    ? ports.filter(p =>
        String(p.port).includes(q) ||
        p.proto.includes(q) ||
        p.process.toLowerCase().includes(q) ||
        (p.container ?? "").toLowerCase().includes(q) ||
        (p.note ?? "").toLowerCase().includes(q),
      )
    : ports;

  return (
    <Dialog
      open={open}
      title="Port Scanner"
      onClose={onClose}
      size="2xl"
      footer={
        <button onClick={onClose} className="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors">
          Close
        </button>
      }
    >
      <div className="flex flex-col gap-3">

        {/* Toolbar */}
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-[10px] text-gray-500">listening TCP / UDP ports on this host</span>
          <div className="ml-auto flex items-center gap-2">
            <div className="relative">
              <input
                type="text"
                value={filter}
                onChange={e => setFilter(e.target.value)}
                placeholder="Filter…"
                className="w-40 bg-gray-800 border border-gray-700 rounded-lg px-3 py-1 pr-7 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-amber-500"
              />
              {filter && (
                <button
                  onClick={() => setFilter("")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-white transition-colors"
                >
                  ✕
                </button>
              )}
            </div>
            <button
              onClick={() => void load()}
              disabled={loading}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs bg-gray-800 text-gray-300 hover:text-white hover:bg-gray-700 disabled:opacity-50 transition-colors"
            >
              <RefreshCw size={11} className={loading ? "animate-spin" : ""} />
              Refresh
            </button>
          </div>
        </div>

        {error && <p className="text-red-400 text-xs">{error}</p>}

        {/* Table */}
        <div className="overflow-auto rounded-xl border border-gray-800 max-h-[60vh]">
          <table className="w-full text-xs text-left border-collapse">
            <thead className="sticky top-0 bg-gray-900 border-b border-gray-800 z-10">
              <tr>
                <th className="px-4 py-2.5 text-gray-500 font-medium w-20">Port</th>
                <th className="px-4 py-2.5 text-gray-500 font-medium w-16">Proto</th>
                <th className="px-4 py-2.5 text-gray-500 font-medium w-36">Address</th>
                <th className="px-4 py-2.5 text-gray-500 font-medium w-40">Process</th>
                <th className="px-4 py-2.5 text-gray-500 font-medium">Container</th>
                <th className="px-4 py-2.5 text-gray-500 font-medium w-52">Note</th>
              </tr>
            </thead>
            <tbody>
              {loading && ports.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-10 text-center text-gray-600 animate-pulse">
                    Scanning ports…
                  </td>
                </tr>
              ) : displayed.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-10 text-center text-gray-600">
                    {q ? "No matching ports." : "No listening ports found."}
                  </td>
                </tr>
              ) : (
                displayed.map((entry) => {
                  const origIdx = ports.indexOf(entry);
                  return (
                    <tr
                      key={`${entry.port}/${entry.proto}`}
                      className="border-b border-gray-800/60 hover:bg-gray-900/50 transition-colors group"
                    >
                      <td className="px-4 py-2 font-mono font-semibold text-amber-400">
                        {entry.port}
                      </td>
                      <td className="px-4 py-2">
                        <span className={`px-1.5 py-0.5 rounded text-[10px] font-mono uppercase ${PROTO_PILL[entry.proto] ?? "bg-gray-800 text-gray-400"}`}>
                          {entry.proto}
                        </span>
                      </td>
                      <td className="px-4 py-2 font-mono text-gray-400 text-[11px]">{entry.address}</td>
                      <td className="px-4 py-2 text-gray-300">
                        {entry.process || <span className="text-gray-600">—</span>}
                        {entry.pid ? <span className="ml-1 text-gray-600 text-[10px]">[{entry.pid}]</span> : null}
                      </td>
                      <td className="px-4 py-2">
                        {entry.container ? (
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-gray-800 rounded text-gray-300 font-mono text-[10px]">
                            <span className="w-1.5 h-1.5 rounded-full bg-green-500 shrink-0" />
                            {entry.container}
                          </span>
                        ) : (
                          <span className="text-gray-600">—</span>
                        )}
                      </td>
                      <td className="px-4 py-2">
                        <NoteCell entry={entry} onSaved={(note) => updateNote(origIdx, note)} />
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {!loading && ports.length > 0 && (
          <p className="text-[10px] text-gray-700">
            {displayed.length} of {ports.length} ports
          </p>
        )}
      </div>
    </Dialog>
  );
}
