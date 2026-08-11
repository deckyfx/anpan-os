import { useEffect, useState } from "react";
import { Disc3, Pencil, Loader2, Check, Search } from "lucide-react";
import { api } from "../../lib/api";

/** Shape returned by GET /api/files/audio-meta. */
export interface AudioMeta {
  title:  string | null;
  artist: string | null;
  album:  string | null;
  albumArtist: string | null;
  genre:  string | null;
  year:   number | null;
  track:  number | null;
  trackOf: number | null;
  container:  string | null;
  codec:      string | null;
  bitrate:    number | null;
  sampleRate: number | null;
  bitsPerSample: number | null;
  channels:   number | null;
  duration:   number | null;
  lossless:   boolean | null;
  hasArt:     boolean;
}

function formatDuration(seconds: number): string {
  const total = Math.round(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * One-line technical summary, e.g. "FLAC · 24-bit · 96 kHz · stereo · 3:34".
 *
 * Fields are dropped rather than shown empty: bit depth is meaningless for a lossy codec,
 * and a nominal bitrate says little about a VBR file, so each appears only when it
 * actually describes the file in hand.
 */
function technicalSummary(m: AudioMeta): string {
  const parts: string[] = [];
  if (m.container)     parts.push(m.container);
  if (m.bitsPerSample) parts.push(`${m.bitsPerSample}-bit`);
  if (m.sampleRate)    parts.push(`${(m.sampleRate / 1000).toFixed(m.sampleRate % 1000 ? 1 : 0)} kHz`);
  if (m.channels)      parts.push(m.channels === 1 ? "mono" : m.channels === 2 ? "stereo" : `${m.channels}ch`);
  if (m.bitrate && !m.lossless) parts.push(`${Math.round(m.bitrate / 1000)} kbps`);
  if (m.duration)      parts.push(formatDuration(m.duration));
  return parts.join(" · ");
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] uppercase tracking-wider text-gray-600">{label}</dt>
      <dd className="text-xs text-gray-300 truncate" title={value}>{value}</dd>
    </div>
  );
}

/** Fields the editor exposes, in display order. */
const EDIT_FIELDS = [
  { key: "title",       label: "Title"  },
  { key: "artist",      label: "Artist" },
  { key: "album",       label: "Album"  },
  { key: "genre",       label: "Genre"  },
  { key: "year",        label: "Year"   },
  { key: "trackNumber", label: "Track"  },
] as const;

type EditForm = Record<(typeof EDIT_FIELDS)[number]["key"], string>;

/** A suggestion from GET /api/files/audio-lookup. */
interface LookupCandidate {
  title:  string;
  artist: string;
  album:  string;
  genre:  string | null;
  year:   string | null;
  artworkUrl: string | null;
  source: "itunes" | "musicbrainz";
}

function formFromMeta(m: AudioMeta): EditForm {
  return {
    title:       m.title  ?? "",
    artist:      m.artist ?? "",
    album:       m.album  ?? "",
    genre:       m.genre  ?? "",
    year:        m.year   != null ? String(m.year)  : "",
    trackNumber: m.track  != null ? String(m.track) : "",
  };
}

/**
 * Tags and cover art for an audio file, shown beneath its player.
 *
 * Renders nothing at all when a non-MP3 has no readable metadata — an empty card under a
 * working player reads as breakage, where absence reads as "this file simply has no tags".
 * An MP3 always gets the panel, because a tagless MP3 is precisely the file someone opens
 * the editor to fix.
 */
export function AudioMetaPanel({ path }: { path: string }) {
  const [meta, setMeta]     = useState<AudioMeta | null>(null);
  const [failed, setFailed] = useState(false);
  const [editing, setEditing] = useState(false);
  const [form, setForm]       = useState<EditForm | null>(null);
  const [saving, setSaving]   = useState(false);
  const [saveError, setSaveError] = useState("");
  const [savedAt, setSavedAt] = useState(0);
  const [candidates, setCandidates] = useState<LookupCandidate[] | null>(null);
  const [lookingUp, setLookingUp]   = useState(false);
  const [lookupError, setLookupError] = useState("");

  // ID3 frames are an MP3 concept; FLAC and MP4 use different tagging entirely, and the
  // server refuses them rather than remuxing a whole file to change one string.
  const isMp3 = path.toLowerCase().endsWith(".mp3");

  useEffect(() => {
    let cancelled = false;
    setMeta(null);
    setFailed(false);
    setEditing(false);
    setSaveError("");

    void (async () => {
      try {
        const { data, error } = await api.api.files["audio-meta"].get({ query: { path } });
        if (cancelled) return;
        if (error || !data) { setFailed(true); return; }
        setMeta(data as AudioMeta);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();

    // Guards against a slower response for a previous file overwriting a newer one when
    // the user steps quickly through a directory.
    return () => { cancelled = true; };
    // savedAt re-runs this after a successful write, so the panel shows what is on disk
    // rather than what was typed.
  }, [path, savedAt]);

  const runLookup = async () => {
    if (!form) return;
    // Track plus artist is what identifies a recording; album alone matches too broadly.
    const q = [form.title, form.artist].filter(Boolean).join(" ").trim();
    if (!q) { setLookupError("Enter a title or artist first"); return; }

    setLookingUp(true);
    setLookupError("");
    setCandidates(null);
    try {
      const { data, error } = await api.api.files["audio-lookup"].get({ query: { q } });
      if (error) {
        // 403 here is the config gate, and its message explains how to turn it on.
        setLookupError((error as { value?: { error?: string } }).value?.error ?? "Lookup failed");
        return;
      }
      const found = (data as { candidates?: LookupCandidate[] } | null)?.candidates ?? [];
      if (found.length === 0) setLookupError("No matches found");
      setCandidates(found);
    } catch (e) {
      setLookupError(e instanceof Error ? e.message : "Lookup failed");
    } finally {
      setLookingUp(false);
    }
  };

  /** Fill the form from a candidate, leaving fields the candidate does not carry. */
  const applyCandidate = (c: LookupCandidate) => {
    setForm(f => f && ({
      ...f,
      title:  c.title  || f.title,
      artist: c.artist || f.artist,
      album:  c.album  || f.album,
      genre:  c.genre  ?? f.genre,
      year:   c.year   ?? f.year,
    }));
    setCandidates(null);
  };

  const save = async () => {
    if (!form) return;
    setSaving(true);
    setSaveError("");
    try {
      const { error } = await api.api.files["audio-tags"].post({ path, ...form });
      if (error) {
        setSaveError((error as { value?: { error?: string } }).value?.error ?? "Could not save tags");
        return;
      }
      setEditing(false);
      setSavedAt(Date.now());
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Could not save tags");
    } finally {
      setSaving(false);
    }
  };

  if (failed || !meta) return null;

  const hasTags = meta.title || meta.artist || meta.album;
  const summary = technicalSummary(meta);
  // An MP3 with no tags at all still gets the panel — that is exactly the file someone
  // opens the editor to fix.
  if (!hasTags && !summary && !isMp3) return null;

  // savedAt busts the browser cache: the response carries max-age, so after a write the
  // old art would otherwise persist even though the file changed.
  const artUrl = `/api/files/audio-art?path=${encodeURIComponent(path)}${savedAt ? `&v=${savedAt}` : ""}`;

  return (
    <div className="mt-4 flex gap-4 items-start bg-gray-950 border border-gray-800 rounded-xl p-4">
      <div className="w-24 h-24 shrink-0 rounded-lg overflow-hidden bg-gray-900 border border-gray-800 flex items-center justify-center">
        {meta.hasArt
          ? <img src={artUrl} alt={meta.album ? `${meta.album} cover art` : "Cover art"} className="w-full h-full object-cover" />
          : <Disc3 size={28} className="text-gray-700" aria-hidden="true" />}
      </div>

      <div className="min-w-0 flex-1">
        {editing && form ? (
          <form
            onSubmit={(e) => { e.preventDefault(); void save(); }}
            className="space-y-2"
          >
            <div className="grid grid-cols-2 gap-2">
              {EDIT_FIELDS.map(({ key, label }) => (
                <label key={key} className={key === "title" || key === "artist" ? "col-span-2" : ""}>
                  <span className="block text-[10px] uppercase tracking-wider text-gray-600 mb-0.5">{label}</span>
                  <input
                    value={form[key]}
                    onChange={(e) => setForm(f => (f ? { ...f, [key]: e.target.value } : f))}
                    className="w-full bg-gray-900 border border-gray-700 rounded-lg px-2 py-1 text-xs text-gray-200 focus:outline-none focus:border-blue-500"
                  />
                </label>
              ))}
            </div>

            {/* Online lookup — only ever reachable from the editor, so a search cannot
                happen merely by previewing a file. */}
            <div className="pt-1">
              <button
                type="button"
                onClick={() => void runLookup()}
                disabled={lookingUp}
                className="inline-flex items-center gap-1.5 text-xs text-gray-400 hover:text-white disabled:opacity-50 transition-colors"
              >
                {lookingUp ? <Loader2 size={12} className="animate-spin" /> : <Search size={12} />}
                {lookingUp ? "Searching…" : "Search online"}
              </button>
              {lookupError && <p className="mt-1 text-xs text-amber-400">{lookupError}</p>}
            </div>

            {candidates && candidates.length > 0 && (
              <ul className="max-h-40 overflow-y-auto rounded-lg border border-gray-800 divide-y divide-gray-800">
                {candidates.map((c, i) => (
                  <li key={`${c.source}-${i}`}>
                    <button
                      type="button"
                      onClick={() => applyCandidate(c)}
                      className="w-full text-left px-2.5 py-2 hover:bg-gray-900 transition-colors"
                    >
                      <p className="text-xs text-gray-200 truncate">{c.title}</p>
                      <p className="text-[11px] text-gray-500 truncate">
                        {c.artist}
                        {c.album ? ` · ${c.album}` : ""}
                        {c.year ? ` · ${c.year}` : ""}
                        <span className="text-gray-700"> · {c.source}</span>
                      </p>
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {saveError && <p className="text-xs text-red-400">{saveError}</p>}

            <div className="flex items-center gap-2 pt-1">
              <button
                type="submit"
                disabled={saving}
                className="px-3 py-1.5 rounded-lg text-xs font-medium bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white transition-colors flex items-center gap-1.5"
              >
                {saving ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                {saving ? "Saving…" : "Save tags"}
              </button>
              <button
                type="button"
                onClick={() => { setEditing(false); setSaveError(""); }}
                disabled={saving}
                className="px-3 py-1.5 rounded-lg text-xs bg-gray-800 hover:bg-gray-700 disabled:opacity-50 text-gray-300 transition-colors"
              >
                Cancel
              </button>
              <span className="text-[10px] text-gray-600 ml-auto">Empty clears a field</span>
            </div>
          </form>
        ) : (
        <>
        {meta.title && <p className="text-sm text-gray-100 font-medium truncate" title={meta.title}>{meta.title}</p>}
        {meta.artist && <p className="text-xs text-gray-400 truncate" title={meta.artist}>{meta.artist}</p>}
        {meta.album && (
          <p className="text-xs text-gray-500 truncate" title={meta.album}>
            {meta.album}
            {meta.year ? ` · ${meta.year}` : ""}
            {meta.track ? ` · track ${meta.track}${meta.trackOf ? `/${meta.trackOf}` : ""}` : ""}
          </p>
        )}

        {summary && (
          <p className="mt-2 text-[11px] text-gray-600 font-mono truncate" title={summary}>
            {summary}
            {meta.lossless ? " · lossless" : ""}
          </p>
        )}

        {(meta.albumArtist || meta.genre) && (
          <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1">
            {meta.albumArtist && meta.albumArtist !== meta.artist && (
              <Field label="Album artist" value={meta.albumArtist} />
            )}
            {meta.genre && <Field label="Genre" value={meta.genre} />}
          </dl>
        )}

        {isMp3 && (
          <button
            onClick={() => { setForm(formFromMeta(meta)); setSaveError(""); setEditing(true); }}
            className="mt-3 inline-flex items-center gap-1.5 text-xs text-gray-400 hover:text-white transition-colors"
          >
            <Pencil size={12} />
            Edit tags
          </button>
        )}
        </>
        )}
      </div>
    </div>
  );
}
