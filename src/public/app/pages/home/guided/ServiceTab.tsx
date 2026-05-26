import { useState, useEffect, useRef } from "react";
import { Plus, Trash2, ChevronDown, ChevronRight, Tag, Loader2, FolderOpen } from "lucide-react";
import { api } from "../../../lib/api";
import { PathPickerDialog } from "../../../components/PathPickerDialog";
import type { ServiceForm } from "./types";

// ─── Shared styles ────────────────────────────────────────────────────────────

const inp = "bg-gray-800 border border-gray-700 rounded-lg px-2.5 py-1.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500 font-mono w-full";
const sel = "bg-gray-800 border border-gray-700 rounded-lg px-2.5 py-1.5 text-sm text-white focus:outline-none focus:border-blue-500";

// ─── Generic helpers ──────────────────────────────────────────────────────────

function AddBtn({ onClick, label = "Add" }: { onClick: () => void; label?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-300 transition-colors mt-1"
    >
      <Plus size={12} /> {label}
    </button>
  );
}

function RemoveBtn({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="p-1 text-gray-600 hover:text-red-400 transition-colors shrink-0">
      <Trash2 size={12} />
    </button>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-widest">{title}</p>
      {children}
    </div>
  );
}

// ─── Tag picker ───────────────────────────────────────────────────────────────

interface TagEntry { name: string; updated: string }

function TagPicker({ imageName, currentTag, onSelect }: {
  imageName:  string;
  currentTag: string;
  onSelect:   (tag: string) => void;
}) {
  const [open,    setOpen]    = useState(false);
  const [tags,    setTags]    = useState<TagEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState("");
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const fetch = async () => {
    if (!imageName.trim()) return;
    setLoading(true);
    setError("");
    setOpen(true);
    try {
      const { data, error: err } = await api.api.compose.tags.get({ query: { image: imageName.trim() } });
      if (err) { setError((err.value as { error?: string })?.error ?? "Failed"); return; }
      setTags((data as { tags: TagEntry[] }).tags ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to fetch tags");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="relative shrink-0">
      <button
        type="button"
        onClick={() => open ? setOpen(false) : void fetch()}
        title="Fetch available tags"
        className="p-1.5 rounded text-gray-500 hover:text-blue-400 hover:bg-gray-700 transition-colors"
      >
        {loading ? <Loader2 size={13} className="animate-spin" /> : <Tag size={13} />}
      </button>

      {open && (
        <div ref={dropdownRef} className="absolute right-0 top-8 z-20 w-52 bg-gray-900 border border-gray-700 rounded-xl shadow-2xl py-1 max-h-56 overflow-y-auto">
          {error && <p className="px-3 py-2 text-xs text-red-400">{error}</p>}
          {!error && tags.length === 0 && !loading && (
            <p className="px-3 py-2 text-xs text-gray-500">No tags found</p>
          )}
          {tags.map(t => (
            <button
              key={t.name}
              type="button"
              onClick={() => { onSelect(t.name); setOpen(false); }}
              className={`w-full flex items-center justify-between px-3 py-1.5 text-xs hover:bg-gray-800 transition-colors text-left ${
                t.name === currentTag ? "text-blue-400" : "text-gray-200"
              }`}
            >
              <span className="font-mono">{t.name}</span>
              {t.name === currentTag && <span className="text-[9px] text-blue-500">current</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── ServiceTab ───────────────────────────────────────────────────────────────

interface Props {
  value:    ServiceForm;
  onChange: (v: ServiceForm) => void;
}

export function ServiceTab({ value: form, onChange }: Props) {
  const set = (partial: Partial<ServiceForm>) => onChange({ ...form, ...partial });
  const [advOpen, setAdvOpen] = useState(false);
  const [extOpen, setExtOpen] = useState(false);
  const [pickerIdx, setPickerIdx] = useState<number | null>(null);

  return (
    <div className="space-y-6 px-1">

      {/* Image */}
      <Section title="Image">
        <div className="flex items-center gap-2">
          <input
            className={inp}
            value={form.imageName}
            onChange={e => set({ imageName: e.target.value })}
            placeholder="nginx"
          />
          <span className="text-gray-600 shrink-0">:</span>
          <input
            className="bg-gray-800 border border-gray-700 rounded-lg px-2.5 py-1.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500 font-mono w-28 shrink-0"
            value={form.imageTag}
            onChange={e => set({ imageTag: e.target.value })}
            placeholder="latest"
          />
          <TagPicker
            imageName={form.imageName}
            currentTag={form.imageTag}
            onSelect={tag => set({ imageTag: tag })}
          />
        </div>
      </Section>

      {/* Restart */}
      <Section title="Restart policy">
        <select
          className={sel}
          value={form.restart}
          onChange={e => set({ restart: e.target.value as ServiceForm["restart"] })}
        >
          <option value="no">no</option>
          <option value="always">always</option>
          <option value="on-failure">on-failure</option>
          <option value="unless-stopped">unless-stopped</option>
        </select>
      </Section>

      {/* Container name */}
      <Section title="Container name">
        <input
          className={inp}
          value={form.containerName}
          onChange={e => set({ containerName: e.target.value })}
          placeholder="(optional)"
        />
      </Section>

      {/* Ports */}
      <Section title="Ports">
        {form.ports.map((p, i) => (
          <div key={i} className="flex items-center gap-2">
            <input
              className={inp}
              value={p.host}
              onChange={e => {
                const ports = [...form.ports];
                ports[i] = { ...p, host: e.target.value };
                set({ ports });
              }}
              placeholder="host"
            />
            <span className="text-gray-600 shrink-0">:</span>
            <input
              className={inp}
              value={p.container}
              onChange={e => {
                const ports = [...form.ports];
                ports[i] = { ...p, container: e.target.value };
                set({ ports });
              }}
              placeholder="container"
            />
            <select
              className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-sm text-white focus:outline-none focus:border-blue-500 shrink-0"
              value={p.protocol}
              onChange={e => {
                const ports = [...form.ports];
                ports[i] = { ...p, protocol: e.target.value as "tcp" | "udp" };
                set({ ports });
              }}
            >
              <option value="tcp">tcp</option>
              <option value="udp">udp</option>
            </select>
            <RemoveBtn onClick={() => set({ ports: form.ports.filter((_, j) => j !== i) })} />
          </div>
        ))}
        <AddBtn onClick={() => set({ ports: [...form.ports, { host: "", container: "", protocol: "tcp" }] })} />
      </Section>

      {/* Environment */}
      <Section title="Environment variables">
        {form.environment.map((e, i) => (
          <div key={i} className="flex items-center gap-2">
            <input
              className={inp}
              value={e.key}
              onChange={ev => {
                const environment = [...form.environment];
                environment[i] = { ...e, key: ev.target.value };
                set({ environment });
              }}
              placeholder="KEY"
            />
            <span className="text-gray-600 shrink-0">=</span>
            <input
              className={inp}
              value={e.value ?? ""}
              onChange={ev => {
                const environment = [...form.environment];
                environment[i] = { ...e, value: ev.target.value };
                set({ environment });
              }}
              placeholder={e.value === null ? "(inherit from host)" : "value"}
            />
            <RemoveBtn onClick={() => set({ environment: form.environment.filter((_, j) => j !== i) })} />
          </div>
        ))}
        <AddBtn onClick={() => set({ environment: [...form.environment, { key: "", value: "" }] })} />
      </Section>

      {/* Volumes */}
      <Section title="Volumes">
        {form.volumes.map((v, i) => (
          <div key={i} className="flex items-center gap-2">
            <div className="flex items-center gap-1 flex-1 min-w-0">
              <input
                className={inp}
                value={v.host}
                onChange={e => {
                  const volumes = [...form.volumes];
                  volumes[i] = { ...v, host: e.target.value };
                  set({ volumes });
                }}
                placeholder="host path"
              />
              <button
                type="button"
                title="Browse…"
                onClick={() => setPickerIdx(i)}
                className="p-1.5 rounded-lg text-gray-400 hover:text-amber-400 hover:bg-gray-700 transition-colors shrink-0"
              >
                <FolderOpen size={15} />
              </button>
            </div>
            <span className="text-gray-600 shrink-0">:</span>
            <div className="flex-1 min-w-0">
              <input
                className={inp}
                value={v.container}
                onChange={e => {
                  const volumes = [...form.volumes];
                  volumes[i] = { ...v, container: e.target.value };
                  set({ volumes });
                }}
                placeholder="container path"
              />
            </div>
            <select
              className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-sm text-white focus:outline-none focus:border-blue-500 shrink-0"
              value={v.mode}
              onChange={e => {
                const volumes = [...form.volumes];
                volumes[i] = { ...v, mode: e.target.value as "" | "ro" | "rw" };
                set({ volumes });
              }}
            >
              <option value="">rw (default)</option>
              <option value="ro">ro</option>
              <option value="rw">rw (explicit)</option>
            </select>
            <RemoveBtn onClick={() => set({ volumes: form.volumes.filter((_, j) => j !== i) })} />
          </div>
        ))}
        <AddBtn onClick={() => set({ volumes: [...form.volumes, { host: "", container: "", mode: "" }] })} />
      </Section>

      {/* Networks */}
      <Section title="Networks">
        {form.networks.map((n, i) => (
          <div key={i} className="flex items-center gap-2">
            <input
              className={inp}
              value={n}
              onChange={e => {
                const networks = [...form.networks];
                networks[i] = e.target.value;
                set({ networks });
              }}
              placeholder="network name"
            />
            <RemoveBtn onClick={() => set({ networks: form.networks.filter((_, j) => j !== i) })} />
          </div>
        ))}
        <AddBtn onClick={() => set({ networks: [...form.networks, ""] })} />
      </Section>

      {/* Depends on */}
      <Section title="Depends on">
        {form.dependsOn.map((d, i) => (
          <div key={i} className="flex items-center gap-2">
            <input
              className={inp}
              value={d}
              onChange={e => {
                const dependsOn = [...form.dependsOn];
                dependsOn[i] = e.target.value;
                set({ dependsOn });
              }}
              placeholder="service name"
            />
            <RemoveBtn onClick={() => set({ dependsOn: form.dependsOn.filter((_, j) => j !== i) })} />
          </div>
        ))}
        <AddBtn onClick={() => set({ dependsOn: [...form.dependsOn, ""] })} />
      </Section>

      {/* Labels */}
      <Section title="Labels">
        {form.labels.map((lbl, i) => (
          <div key={i} className="flex items-center gap-2">
            <input
              className={inp}
              value={lbl.key}
              onChange={e => {
                const labels = [...form.labels];
                labels[i] = { ...lbl, key: e.target.value };
                set({ labels });
              }}
              placeholder="com.example.key"
            />
            <span className="text-gray-600 shrink-0">=</span>
            <input
              className={inp}
              value={lbl.value}
              onChange={e => {
                const labels = [...form.labels];
                labels[i] = { ...lbl, value: e.target.value };
                set({ labels });
              }}
              placeholder="value"
            />
            <RemoveBtn onClick={() => set({ labels: form.labels.filter((_, j) => j !== i) })} />
          </div>
        ))}
        <AddBtn onClick={() => set({ labels: [...form.labels, { key: "", value: "" }] })} />
      </Section>

      {/* Flags */}
      <Section title="Flags">
        <label className="flex items-center gap-2.5 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={form.privileged}
            onChange={e => set({ privileged: e.target.checked })}
            className="w-4 h-4 rounded accent-blue-500"
          />
          <span className="text-sm text-gray-300">Privileged</span>
          <span className="text-xs text-gray-600">(grants all Linux capabilities)</span>
        </label>
        <label className="flex items-center gap-2.5 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={form.stdinOpen}
            onChange={e => set({ stdinOpen: e.target.checked })}
            className="w-4 h-4 rounded accent-blue-500"
          />
          <span className="text-sm text-gray-300">stdin_open</span>
          <span className="text-xs text-gray-600">(keep STDIN open)</span>
        </label>
        <label className="flex items-center gap-2.5 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={form.tty}
            onChange={e => set({ tty: e.target.checked })}
            className="w-4 h-4 rounded accent-blue-500"
          />
          <span className="text-sm text-gray-300">tty</span>
          <span className="text-xs text-gray-600">(allocate pseudo-TTY)</span>
        </label>
      </Section>

      {/* Memory limit */}
      <Section title="Memory limit">
        <div className="flex items-center gap-3">
          <input
            type="range"
            min={0}
            max={8192}
            step={64}
            value={form.memLimitMb}
            onChange={e => set({ memLimitMb: parseInt(e.target.value, 10) })}
            className="flex-1 accent-blue-500"
          />
          <span className="text-sm text-gray-300 w-24 text-right shrink-0">
            {form.memLimitMb === 0 ? "No limit" : `${form.memLimitMb} MB`}
          </span>
        </div>
      </Section>

      {/* CPU limit */}
      <Section title="CPU limit">
        <div className="flex items-center gap-3">
          <input
            type="range"
            min={0}
            max={800}
            step={10}
            value={Math.round(form.cpuLimit * 100)}
            onChange={e => set({ cpuLimit: parseInt(e.target.value, 10) / 100 })}
            className="flex-1 accent-blue-500"
          />
          <span className="text-sm text-gray-300 w-24 text-right shrink-0">
            {form.cpuLimit === 0 ? "No limit" : `${form.cpuLimit.toFixed(2)} cores`}
          </span>
        </div>
      </Section>

      {/* Extended config (collapsible) */}
      <div>
        <button
          type="button"
          onClick={() => setExtOpen(v => !v)}
          className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-300 transition-colors mb-2"
        >
          {extOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <span className="font-semibold uppercase tracking-widest">Network &amp; Runtime</span>
        </button>
        {extOpen && (
          <div className="space-y-4 pl-3 border-l border-gray-800">

            <div>
              <label className="block text-[10px] text-gray-500 uppercase tracking-widest mb-1.5">Network mode</label>
              <input
                className={inp}
                value={form.networkMode}
                onChange={e => set({ networkMode: e.target.value })}
                placeholder="host / none / container:name"
              />
            </div>

            <div>
              <label className="block text-[10px] text-gray-500 uppercase tracking-widest mb-1.5">User</label>
              <input
                className={inp}
                value={form.user}
                onChange={e => set({ user: e.target.value })}
                placeholder="1000:1000"
              />
            </div>

            <div>
              <label className="block text-[10px] text-gray-500 uppercase tracking-widest mb-1.5">Working directory</label>
              <input
                className={inp}
                value={form.workingDir}
                onChange={e => set({ workingDir: e.target.value })}
                placeholder="/app"
              />
            </div>

            {/* cap_add */}
            <div>
              <label className="block text-[10px] text-gray-500 uppercase tracking-widest mb-1.5">cap_add</label>
              {form.capAdd.map((c, i) => (
                <div key={i} className="flex items-center gap-2 mb-1">
                  <input
                    className={inp}
                    value={c}
                    onChange={e => { const a = [...form.capAdd]; a[i] = e.target.value; set({ capAdd: a }); }}
                    placeholder="NET_ADMIN"
                  />
                  <RemoveBtn onClick={() => set({ capAdd: form.capAdd.filter((_, j) => j !== i) })} />
                </div>
              ))}
              <AddBtn onClick={() => set({ capAdd: [...form.capAdd, ""] })} />
            </div>

            {/* cap_drop */}
            <div>
              <label className="block text-[10px] text-gray-500 uppercase tracking-widest mb-1.5">cap_drop</label>
              {form.capDrop.map((c, i) => (
                <div key={i} className="flex items-center gap-2 mb-1">
                  <input
                    className={inp}
                    value={c}
                    onChange={e => { const a = [...form.capDrop]; a[i] = e.target.value; set({ capDrop: a }); }}
                    placeholder="ALL"
                  />
                  <RemoveBtn onClick={() => set({ capDrop: form.capDrop.filter((_, j) => j !== i) })} />
                </div>
              ))}
              <AddBtn onClick={() => set({ capDrop: [...form.capDrop, ""] })} />
            </div>

            {/* devices */}
            <div>
              <label className="block text-[10px] text-gray-500 uppercase tracking-widest mb-1.5">Devices</label>
              {form.devices.map((d, i) => (
                <div key={i} className="flex items-center gap-2 mb-1">
                  <input
                    className={inp}
                    value={d}
                    onChange={e => { const a = [...form.devices]; a[i] = e.target.value; set({ devices: a }); }}
                    placeholder="/dev/snd:/dev/snd"
                  />
                  <RemoveBtn onClick={() => set({ devices: form.devices.filter((_, j) => j !== i) })} />
                </div>
              ))}
              <AddBtn onClick={() => set({ devices: [...form.devices, ""] })} />
            </div>

            {/* extra_hosts */}
            <div>
              <label className="block text-[10px] text-gray-500 uppercase tracking-widest mb-1.5">Extra hosts</label>
              {form.extraHosts.map((h, i) => (
                <div key={i} className="flex items-center gap-2 mb-1">
                  <input
                    className={inp}
                    value={h}
                    onChange={e => { const a = [...form.extraHosts]; a[i] = e.target.value; set({ extraHosts: a }); }}
                    placeholder="host.docker.internal:host-gateway"
                  />
                  <RemoveBtn onClick={() => set({ extraHosts: form.extraHosts.filter((_, j) => j !== i) })} />
                </div>
              ))}
              <AddBtn onClick={() => set({ extraHosts: [...form.extraHosts, ""] })} />
            </div>

            {/* dns */}
            <div>
              <label className="block text-[10px] text-gray-500 uppercase tracking-widest mb-1.5">DNS servers</label>
              {form.dns.map((d, i) => (
                <div key={i} className="flex items-center gap-2 mb-1">
                  <input
                    className={inp}
                    value={d}
                    onChange={e => { const a = [...form.dns]; a[i] = e.target.value; set({ dns: a }); }}
                    placeholder="8.8.8.8"
                  />
                  <RemoveBtn onClick={() => set({ dns: form.dns.filter((_, j) => j !== i) })} />
                </div>
              ))}
              <AddBtn onClick={() => set({ dns: [...form.dns, ""] })} />
            </div>

            {/* logging */}
            <div className="space-y-2">
              <label className="block text-[10px] text-gray-500 uppercase tracking-widest">Logging</label>
              <div>
                <label className="block text-[10px] text-gray-600 mb-1">Driver</label>
                <input
                  className={inp}
                  value={form.logging.driver}
                  onChange={e => set({ logging: { ...form.logging, driver: e.target.value } })}
                  placeholder="json-file / syslog / none"
                />
              </div>
              {form.logging.options.map((opt, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input
                    className={inp}
                    value={opt.key}
                    onChange={e => {
                      const options = [...form.logging.options];
                      options[i] = { ...opt, key: e.target.value };
                      set({ logging: { ...form.logging, options } });
                    }}
                    placeholder="max-size"
                  />
                  <span className="text-gray-600 shrink-0">=</span>
                  <input
                    className={inp}
                    value={opt.value}
                    onChange={e => {
                      const options = [...form.logging.options];
                      options[i] = { ...opt, value: e.target.value };
                      set({ logging: { ...form.logging, options } });
                    }}
                    placeholder="10m"
                  />
                  <RemoveBtn onClick={() => set({ logging: { ...form.logging, options: form.logging.options.filter((_, j) => j !== i) } })} />
                </div>
              ))}
              <AddBtn
                label="Add option"
                onClick={() => set({ logging: { ...form.logging, options: [...form.logging.options, { key: "", value: "" }] } })}
              />
            </div>

          </div>
        )}
      </div>

      {/* Advanced (collapsible) */}
      <div>
        <button
          type="button"
          onClick={() => setAdvOpen(v => !v)}
          className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-300 transition-colors mb-2"
        >
          {advOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <span className="font-semibold uppercase tracking-widest">Advanced</span>
        </button>
        {advOpen && (
          <div className="space-y-4 pl-3 border-l border-gray-800">

            <div>
              <label className="block text-[10px] text-gray-500 uppercase tracking-widest mb-1.5">Command</label>
              <input
                className={inp}
                value={form.command}
                onChange={e => set({ command: e.target.value })}
                placeholder="e.g. --config /etc/app.conf"
              />
            </div>

            <div>
              <label className="block text-[10px] text-gray-500 uppercase tracking-widest mb-1.5">Entrypoint</label>
              <input
                className={inp}
                value={form.entrypoint}
                onChange={e => set({ entrypoint: e.target.value })}
                placeholder="/docker-entrypoint.sh"
              />
            </div>

            <div className="space-y-2">
              <p className="text-[10px] text-gray-500 uppercase tracking-widest">Healthcheck</p>
              <div>
                <label className="block text-[10px] text-gray-600 mb-1">Test command</label>
                <input
                  className={inp}
                  value={form.healthcheckTest}
                  onChange={e => set({ healthcheckTest: e.target.value })}
                  placeholder="curl -f http://localhost/ || exit 1"
                />
              </div>
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="block text-[10px] text-gray-600 mb-1">Interval</label>
                  <input
                    className={inp}
                    value={form.healthcheckInterval}
                    onChange={e => set({ healthcheckInterval: e.target.value })}
                    placeholder="30s"
                  />
                </div>
                <div>
                  <label className="block text-[10px] text-gray-600 mb-1">Timeout</label>
                  <input
                    className={inp}
                    value={form.healthcheckTimeout}
                    onChange={e => set({ healthcheckTimeout: e.target.value })}
                    placeholder="10s"
                  />
                </div>
                <div>
                  <label className="block text-[10px] text-gray-600 mb-1">Retries</label>
                  <input
                    type="number"
                    min={0}
                    className={inp}
                    value={form.healthcheckRetries || ""}
                    onChange={e => set({ healthcheckRetries: parseInt(e.target.value, 10) || 0 })}
                    placeholder="3"
                  />
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Host path picker */}
      <PathPickerDialog
        open={pickerIdx !== null}
        title="Select host path"
        mode="dir"
        initialPath={pickerIdx !== null ? (form.volumes[pickerIdx]?.host || "/") : "/"}
        onSelect={path => {
          if (pickerIdx === null || pickerIdx < 0 || pickerIdx >= form.volumes.length) return;
          const existing = form.volumes[pickerIdx];
          if (!existing) return;
          const volumes = [...form.volumes];
          volumes[pickerIdx] = { ...existing, host: path };
          set({ volumes });
        }}
        onClose={() => setPickerIdx(null)}
      />
    </div>
  );
}
