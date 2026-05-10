import { Plus, Trash2 } from "lucide-react";
import type { StackConfig, NamedNetwork, NamedVolume } from "./types";

const row    = "flex items-center gap-2";
const inp    = "flex-1 min-w-0 bg-gray-800 border border-gray-700 rounded-lg px-2 py-1 text-xs text-white placeholder-gray-600 focus:outline-none focus:border-amber-500";
const addBtn = "flex items-center gap-1 text-xs text-amber-400 hover:text-amber-300 mt-2";
const delBtn = "text-gray-600 hover:text-red-400 shrink-0";
const label  = "block text-[10px] font-semibold text-gray-500 uppercase tracking-widest mb-2";
const card   = "border border-gray-700 rounded-lg p-3 space-y-2 bg-gray-800/30";

// ─── Networks ─────────────────────────────────────────────────────────────────

function NetworkRow({
  net,
  onChange,
  onRemove,
}: {
  net: NamedNetwork;
  onChange: (v: NamedNetwork) => void;
  onRemove: () => void;
}) {
  return (
    <div className={`${card} space-y-2`}>
      <div className={row}>
        <input
          className={inp}
          placeholder="name"
          value={net.name}
          onChange={e => onChange({ ...net, name: e.target.value })}
        />
        <button type="button" onClick={onRemove} className={delBtn}><Trash2 size={13} /></button>
      </div>
      <div className={row}>
        <input
          className={inp}
          placeholder="driver (bridge)"
          value={net.driver}
          onChange={e => onChange({ ...net, driver: e.target.value })}
        />
      </div>
      <div className="flex items-center gap-4">
        <label className="flex items-center gap-1.5 text-xs text-gray-400 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={net.external}
            onChange={e => onChange({ ...net, external: e.target.checked })}
            className="accent-amber-500"
          />
          external
        </label>
        <label className="flex items-center gap-1.5 text-xs text-gray-400 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={net.attachable}
            onChange={e => onChange({ ...net, attachable: e.target.checked })}
            className="accent-amber-500"
          />
          attachable
        </label>
      </div>
    </div>
  );
}

// ─── Volumes ──────────────────────────────────────────────────────────────────

function VolumeRow({
  vol,
  onChange,
  onRemove,
}: {
  vol: NamedVolume;
  onChange: (v: NamedVolume) => void;
  onRemove: () => void;
}) {
  const setOpt = (idx: number, key: string, value: string) => {
    const opts = vol.driverOpts.map((o, i) => i === idx ? { key, value } : o);
    onChange({ ...vol, driverOpts: opts });
  };
  const addOpt = () => onChange({ ...vol, driverOpts: [...vol.driverOpts, { key: "", value: "" }] });
  const delOpt = (idx: number) => onChange({ ...vol, driverOpts: vol.driverOpts.filter((_, i) => i !== idx) });

  return (
    <div className={`${card} space-y-2`}>
      <div className={row}>
        <input
          className={inp}
          placeholder="name"
          value={vol.name}
          onChange={e => onChange({ ...vol, name: e.target.value })}
        />
        <button type="button" onClick={onRemove} className={delBtn}><Trash2 size={13} /></button>
      </div>
      <div className={row}>
        <input
          className={inp}
          placeholder="driver (local)"
          value={vol.driver}
          onChange={e => onChange({ ...vol, driver: e.target.value })}
        />
      </div>
      <label className="flex items-center gap-1.5 text-xs text-gray-400 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={vol.external}
          onChange={e => onChange({ ...vol, external: e.target.checked })}
          className="accent-amber-500"
        />
        external
      </label>

      {/* driver_opts */}
      {vol.driverOpts.length > 0 && (
        <div className="space-y-1 pl-2 border-l border-gray-700">
          <p className="text-[9px] text-gray-600 uppercase tracking-widest">driver_opts</p>
          {vol.driverOpts.map((opt, i) => (
            <div key={i} className={row}>
              <input
                className={inp}
                placeholder="key"
                value={opt.key}
                onChange={e => setOpt(i, e.target.value, opt.value)}
              />
              <span className="text-gray-600 shrink-0">=</span>
              <input
                className={inp}
                placeholder="value"
                value={opt.value}
                onChange={e => setOpt(i, opt.key, e.target.value)}
              />
              <button type="button" onClick={() => delOpt(i)} className={delBtn}><Trash2 size={11} /></button>
            </div>
          ))}
        </div>
      )}
      <button type="button" onClick={addOpt} className={`${addBtn} text-[11px]`}>
        <Plus size={11} /> add driver_opt
      </button>
    </div>
  );
}

// ─── StackConfigTab ───────────────────────────────────────────────────────────

export function StackConfigTab({
  value,
  onChange,
  isEdit,
  onNameChange,
}: {
  value:         StackConfig;
  onChange:      (v: StackConfig) => void;
  isEdit?:       boolean;
  onNameChange?: (name: string) => void;
}) {
  const addNet = () =>
    onChange({
      ...value,
      networks: [...value.networks, { name: "", driver: "", external: false, attachable: false }],
    });

  const setNet = (i: number, net: NamedNetwork) =>
    onChange({ ...value, networks: value.networks.map((n, idx) => idx === i ? net : n) });

  const delNet = (i: number) =>
    onChange({ ...value, networks: value.networks.filter((_, idx) => idx !== i) });

  const addVol = () =>
    onChange({
      ...value,
      volumes: [...value.volumes, { name: "", driver: "", external: false, driverOpts: [] }],
    });

  const setVol = (i: number, vol: NamedVolume) =>
    onChange({ ...value, volumes: value.volumes.map((v, idx) => idx === i ? vol : v) });

  const delVol = (i: number) =>
    onChange({ ...value, volumes: value.volumes.filter((_, idx) => idx !== i) });

  return (
    <div className="space-y-6 px-5 py-4">

      {/* Stack Name */}
      <section>
        <p className={label}>
          Stack Name {!isEdit && <span className="text-red-400">*</span>}
          <span className="normal-case font-normal text-gray-600 ml-1">(folder &amp; Docker project name)</span>
        </p>
        {isEdit ? (
          <code className="block px-3 py-2 bg-gray-800/50 border border-gray-700 rounded-lg text-sm text-gray-400 font-mono">
            {value.name || "—"}
          </code>
        ) : (
          <input
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-amber-500 font-mono"
            placeholder="my-app"
            value={value.name}
            onChange={e => onNameChange?.(e.target.value)}
          />
        )}
      </section>

      {/* Networks */}
      <section>
        <p className={label}>Named Networks</p>
        <div className="space-y-2">
          {value.networks.map((net, i) => (
            <NetworkRow key={i} net={net} onChange={n => setNet(i, n)} onRemove={() => delNet(i)} />
          ))}
        </div>
        <button type="button" onClick={addNet} className={addBtn}>
          <Plus size={13} /> add network
        </button>
      </section>

      {/* Volumes */}
      <section>
        <p className={label}>Named Volumes</p>
        <div className="space-y-2">
          {value.volumes.map((vol, i) => (
            <VolumeRow key={i} vol={vol} onChange={v => setVol(i, v)} onRemove={() => delVol(i)} />
          ))}
        </div>
        <button type="button" onClick={addVol} className={addBtn}>
          <Plus size={13} /> add volume
        </button>
      </section>
    </div>
  );
}
