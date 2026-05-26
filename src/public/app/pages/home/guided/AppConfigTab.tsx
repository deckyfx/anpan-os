import { useEffect, useRef, useState } from "react";
import { Upload, X } from "lucide-react";
import type { AppConfigState, OpenMode } from "./types";

const OPEN_MODES: Array<{ value: OpenMode; label: string }> = [
  { value: "new-page",  label: "New Page" },
  { value: "here",      label: "Here" },
  { value: "contained", label: "Contained (soon)" },
];

const inp = "bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-amber-500";

interface Props {
  value:    AppConfigState;
  onChange: (v: AppConfigState) => void;
}

export function AppConfigTab({ value, onChange }: Props) {
  const set = (partial: Partial<AppConfigState>) => onChange({ ...value, ...partial });

  const hostname = typeof window !== "undefined" ? window.location.hostname : "localhost";
  const host     = value.address || hostname;
  const liveUrl  = value.portMap
    ? `${value.scheme}://${host}:${value.portMap}${value.indexPath || "/"}`
    : "";

  // Debounced preview URL — updates 600 ms after the user stops typing
  const [previewSrc, setPreviewSrc] = useState(value.icon);
  const [imageError, setImageError] = useState(false);
  useEffect(() => {
    if (value.icon.startsWith("data:")) { setPreviewSrc(value.icon); setImageError(false); return; }
    const t = setTimeout(() => { setPreviewSrc(value.icon); setImageError(false); }, 600);
    return () => clearTimeout(t);
  }, [value.icon]);

  const fileRef = useRef<HTMLInputElement>(null);

  const handleUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => set({ icon: (ev.target?.result as string) ?? "" });
    reader.readAsDataURL(file);
    // Reset so the same file can be re-selected
    e.target.value = "";
  };

  return (
    <div className="space-y-5 px-5 py-4">

      {/* App Name */}
      <div>
        <label className="block text-[10px] font-semibold text-gray-500 uppercase tracking-widest mb-1.5">
          App Name <span className="text-red-400">*</span>
          <span className="normal-case font-normal text-gray-600 ml-1">(display name)</span>
        </label>
        <input
          type="text"
          value={value.title}
          onChange={e => set({ title: e.target.value })}
          placeholder="My App"
          className={`w-full ${inp}`}
        />
      </div>

      {/* Tagline / Short Description */}
      <div>
        <label className="block text-[10px] font-semibold text-gray-500 uppercase tracking-widest mb-1.5">
          Tagline
          <span className="normal-case font-normal text-gray-600 ml-1">(short description, optional)</span>
        </label>
        <input
          type="text"
          value={value.tagline}
          onChange={e => set({ tagline: e.target.value })}
          placeholder="A brief description of this app"
          className={`w-full ${inp}`}
        />
      </div>

      {/* Icon */}
      <div>
        <label className="block text-[10px] font-semibold text-gray-500 uppercase tracking-widest mb-1.5">Icon</label>
        <div className="flex gap-3">
          {/* Large preview */}
          <div className="relative shrink-0 w-20 h-20 rounded-xl bg-gray-800 border border-gray-700 flex items-center justify-center overflow-hidden group">
            {previewSrc && !imageError ? (
              <img
                key={previewSrc}
                src={previewSrc}
                alt=""
                className="w-full h-full object-cover"
                onError={() => setImageError(true)}
              />
            ) : (
              <span className="text-2xl text-gray-600 font-bold select-none">
                {value.title ? value.title[0]?.toUpperCase() : "?"}
              </span>
            )}
            {/* Clear overlay */}
            {previewSrc && (
              <button
                type="button"
                onClick={() => { set({ icon: "" }); setPreviewSrc(""); }}
                className="absolute inset-0 flex items-center justify-center bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity"
                title="Clear icon"
              >
                <X size={18} className="text-white" />
              </button>
            )}
          </div>

          {/* URL input + upload */}
          <div className="flex-1 flex flex-col gap-2">
            <input
              type="text"
              value={value.icon}
              onChange={e => set({ icon: e.target.value })}
              placeholder="https://example.com/icon.png"
              className={`w-full font-mono ${inp}`}
            />
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-400 hover:text-white rounded-lg transition-colors"
              >
                <Upload size={12} /> Upload image
              </button>
              {value.icon && (
                <button
                  type="button"
                  onClick={() => { set({ icon: "" }); setPreviewSrc(""); }}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-400 hover:text-red-400 rounded-lg transition-colors"
                >
                  <X size={12} /> Clear
                </button>
              )}
            </div>
          </div>
        </div>
        <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={handleUpload} />
      </div>

      {/* URL + Open Mode — single row */}
      <div>
        <label className="block text-[10px] font-semibold text-gray-500 uppercase tracking-widest mb-1.5">
          Access URL
        </label>
        <div className="grid grid-cols-12 gap-2 items-end">
          {/* Scheme — 2 cols */}
          <div className="col-span-2">
            <p className="text-[9px] text-gray-600 uppercase tracking-widest mb-1">Scheme</p>
            <select
              value={value.scheme}
              onChange={e => set({ scheme: e.target.value })}
              className={`w-full ${inp} pr-7`}
            >
              <option value="http">http</option>
              <option value="https">https</option>
            </select>
          </div>
          {/* Address — 3 cols */}
          <div className="col-span-3">
            <p className="text-[9px] text-gray-600 uppercase tracking-widest mb-1">
              Address <span className="normal-case font-normal text-gray-700">(blank = host)</span>
            </p>
            <input
              type="text"
              value={value.address}
              onChange={e => set({ address: e.target.value })}
              placeholder={hostname}
              className={`w-full font-mono ${inp}`}
            />
          </div>
          {/* Port — 2 cols */}
          <div className="col-span-2">
            <p className="text-[9px] text-gray-600 uppercase tracking-widest mb-1">Port</p>
            <input
              type="text"
              value={value.portMap}
              onChange={e => set({ portMap: e.target.value })}
              placeholder="8080"
              className={`w-full font-mono ${inp}`}
            />
          </div>
          {/* Path — 3 cols */}
          <div className="col-span-3">
            <p className="text-[9px] text-gray-600 uppercase tracking-widest mb-1">Path</p>
            <input
              type="text"
              value={value.indexPath}
              onChange={e => set({ indexPath: e.target.value })}
              placeholder="/"
              className={`w-full font-mono ${inp}`}
            />
          </div>
          {/* Open Mode — 2 cols */}
          <div className="col-span-2">
            <p className="text-[9px] text-gray-600 uppercase tracking-widest mb-1">Open</p>
            <select
              value={value.openMode}
              onChange={e => set({ openMode: e.target.value as OpenMode })}
              className={`w-full ${inp}`}
            >
              {OPEN_MODES.map(({ value: mode, label }) => (
                <option key={mode} value={mode} disabled={mode === "contained"}>
                  {label}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* Live URL preview */}
      {liveUrl && (
        <div className="bg-gray-800/60 border border-gray-700 rounded-lg px-4 py-2.5">
          <p className="text-[10px] text-gray-500 uppercase tracking-widest mb-1">Live URL preview</p>
          <a
            href={liveUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-amber-400 hover:text-amber-300 hover:underline font-mono break-all"
          >
            {liveUrl}
          </a>
        </div>
      )}

      {/* Note */}
      <div>
        <label className="block text-[10px] font-semibold text-gray-500 uppercase tracking-widest mb-1.5">
          App Note
          <span className="normal-case font-normal text-gray-600 ml-1">(optional)</span>
        </label>
        <textarea
          value={value.note}
          onChange={e => set({ note: e.target.value })}
          placeholder="Any notes about this stack…"
          rows={3}
          className={`w-full resize-none ${inp}`}
        />
      </div>
    </div>
  );
}
