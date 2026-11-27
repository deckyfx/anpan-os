import { useState, useEffect, useRef, useId } from "react";
import { Loader2, Trash2, AlertTriangle, Plus, RefreshCw } from "lucide-react";
import { Section } from "./Section";
import { InlineConfirm } from "./InlineConfirm";
import { INPUT, LABEL, PRIMARY_BUTTON, QUIET_BUTTON, TARGET } from "./styles";
import { api } from "../../lib/api";
import { useToastStore } from "../../stores/toastStore";

/**
 * Manage API keys: personal tokens that let scripts and other tools call the anpan-os API
 * with `Authorization: Bearer <key>` instead of the browser session.
 *
 * The full token is returned by the server exactly once, on creation. It lives only in this
 * component's state: it stays on screen until the user dismisses it, and is discarded when
 * the user leaves the Account page, so coming back never shows it again. Everything here
 * is inline in the card, never in a dialog a stray click or Escape could close.
 */

type Scope = "read" | "operate" | "full";

/** Mirrors the list item returned by GET /api/api-keys. */
interface ApiKey {
  id: string;
  name: string;
  scope: Scope;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  lastUsedIp: string | null;
}

/** The server refuses to create more than this many keys per user (HTTP 409). */
const MAX_KEYS = 50;
const NAME_MAX = 64;

const SCOPES: { value: Scope; label: string; description: string }[] = [
  { value: "read",    label: "Read",    description: "View only (GET requests). No file access." },
  { value: "operate", label: "Operate", description: "Read, plus install, start, stop and update stacks and containers, run update checks, use the App Store, bookmarks and ports. Not deleting a stack (it removes volumes), prune, files, Samba, CasaOS import or shutdown." },
  { value: "full",    label: "Full",    description: "Everything the web UI can do, except account settings and managing API keys." },
];

const SCOPE_BADGE: Record<Scope, string> = {
  read:    "text-sky-300 bg-sky-500/10 border-sky-500/20",
  operate: "text-amber-300 bg-amber-500/10 border-amber-500/20",
  full:    "text-red-300 bg-red-500/10 border-red-500/20",
};

const EXPIRY_OPTIONS: { value: string; label: string; days: number | null }[] = [
  { value: "30",    label: "30 days", days: 30   },
  { value: "90",    label: "90 days", days: 90   },
  { value: "365",   label: "1 year",  days: 365  },
  { value: "never", label: "Never",   days: null },
];

/** How long copy feedback stays visible. */
const FEEDBACK_MS = 2000;

/** Short locale date, e.g. "Nov 27, 2026". */
function shortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** Full locale date and time, for tooltips. */
function longDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

/** Coarse "time ago" for the last-used column: "just now", "5m ago", "3h ago", "2d ago", else a date. */
function ago(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return iso;
  const mins = Math.floor(ms / 60_000);
  if (mins < 1)  return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days}d ago`;
  return shortDate(iso);
}

function isExpired(k: ApiKey): boolean {
  return k.expiresAt !== null && new Date(k.expiresAt).getTime() <= Date.now();
}

/**
 * One key as a table row, with its Revoke two-step confirm.
 *
 * Module scope rather than inside the section, so a row keeps its identity (and the
 * keyboard focus on its buttons) when the section's state changes.
 */
function KeyRow({ k, confirming, busy, anyBusy, onAsk, onCancel, onRevoke }: {
  k: ApiKey;
  confirming: boolean;
  /** This key's revoke is in flight. */
  busy: boolean;
  /** Any revoke or create is in flight. */
  anyBusy: boolean;
  onAsk: () => void;
  onCancel: () => void;
  onRevoke: () => void;
}) {
  const expired = isExpired(k);
  const td = "px-3 py-2.5 align-middle";

  return (
    <tr className="border-b border-gray-800/40 last:border-0">
      <th scope="row" className={`${td} font-medium text-sm text-gray-200 max-w-56 truncate`} title={k.name}>{k.name}</th>
      <td className={td}>
        <span className="inline-flex items-center gap-1.5">
          <span className={`px-1.5 py-0.5 rounded border text-[10px] font-medium ${SCOPE_BADGE[k.scope]}`}>{k.scope}</span>
          {expired && (
            <span className="px-1.5 py-0.5 rounded border text-[10px] font-medium text-gray-400 bg-gray-500/10 border-gray-500/30">expired</span>
          )}
        </span>
      </td>
      <td className={`${td} text-xs text-gray-400 whitespace-nowrap`} title={longDate(k.createdAt)}>{shortDate(k.createdAt)}</td>
      <td className={`${td} text-xs whitespace-nowrap ${expired ? "text-gray-500" : "text-gray-400"}`} title={k.expiresAt ? longDate(k.expiresAt) : undefined}>
        {k.expiresAt ? shortDate(k.expiresAt) : "Never"}
      </td>
      <td className={`${td} text-xs`}>
        {k.lastUsedAt ? (
          <span title={longDate(k.lastUsedAt)} className="text-gray-400 whitespace-nowrap">
            {ago(k.lastUsedAt)}
            {k.lastUsedIp && <> from <span className="font-mono text-gray-300">{k.lastUsedIp}</span></>}
          </span>
        ) : (
          <span className="text-gray-600">Never used</span>
        )}
      </td>
      <td className={`${td} text-right`}>
        <InlineConfirm
          label="Revoke"
          icon={<Trash2 size={12} />}
          confirmLabel="Revoke key"
          busyLabel="Revoking…"
          subject={`key ${k.name}`}
          confirming={confirming}
          busy={busy}
          disabled={anyBusy}
          onAsk={onAsk}
          onCancel={onCancel}
          onConfirm={onRevoke}
        />
      </td>
    </tr>
  );
}

/**
 * The one-time display of a freshly created token, with its Copy button.
 *
 * The Clipboard API exists only on secure origins, and anpan-os is often reached over
 * plain http on a LAN address. There the token is selected in its field instead, and the
 * user is told to press Ctrl+C. Feedback goes in a `role="status"` region beside the
 * button, faded in and out with opacity (never display:none, which would keep it from
 * being announced).
 */
function NewKeyPanel({ name, token, onDone }: { name: string; token: string; onDone: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const fieldId = useId();
  const noteId = useId();
  const [message, setMessage] = useState("");
  const [shown, setShown]     = useState(false);
  const timersRef = useRef<number[]>([]);

  const clearTimers = () => { timersRef.current.forEach(t => window.clearTimeout(t)); timersRef.current = []; };
  useEffect(() => clearTimers, []);

  const say = (text: string) => {
    clearTimers();
    setMessage(text);
    setShown(true);
    // Fade out, then empty the region once the fade has finished.
    timersRef.current.push(
      window.setTimeout(() => setShown(false), FEEDBACK_MS),
      window.setTimeout(() => setMessage(""), FEEDBACK_MS + 300),
    );
  };

  const select = () => { inputRef.current?.focus(); inputRef.current?.select(); };

  const copy = async () => {
    const text = inputRef.current?.value ?? token;
    if (!navigator.clipboard?.writeText) {
      select();
      say("Press Ctrl+C to copy");
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      say("Copied");
    } catch {
      select();
      say("Copy failed");
    }
  };

  return (
    <div className="p-4 bg-green-500/10 border border-green-500/25 rounded-xl space-y-3">
      <div>
        <p className="text-sm text-green-300 font-medium">Key “{name}” created</p>
        <p id={noteId} className="text-xs text-gray-300 mt-1">
          Copy it now and store it somewhere safe. <strong className="text-white">You won't see this key again</strong> after
          you dismiss this panel or leave this page.
        </p>
      </div>
      <div>
        <label htmlFor={fieldId} className={LABEL}>API key</label>
        <div className="flex items-center gap-2 flex-wrap">
          <input
            id={fieldId}
            ref={inputRef}
            type="text"
            readOnly
            value={token}
            spellCheck={false}
            autoComplete="off"
            aria-describedby={noteId}
            onFocus={e => e.currentTarget.select()}
            className={`${INPUT} font-mono text-xs flex-1 min-w-0 basis-64`}
          />
          <button type="button" onClick={() => void copy()} className={`${QUIET_BUTTON} py-2`}>
            Copy
          </button>
          <span
            role="status"
            className={`text-xs text-gray-300 min-w-[9rem] transition-opacity duration-300 ${shown ? "opacity-100" : "opacity-0"}`}
          >
            {message}
          </span>
        </div>
      </div>
      <div className="flex justify-end">
        <button type="button" onClick={onDone} className={QUIET_BUTTON}>
          Done — I've saved it
        </button>
      </div>
    </div>
  );
}

/** The API keys card on the Account page: list, revoke, create and the one-time token. */
export function ApiKeysSection() {
  const [keys,       setKeys]       = useState<ApiKey[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [loadError,  setLoadError]  = useState("");
  const [confirmId,  setConfirmId]  = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const [name,     setName]     = useState("");
  const [password, setPassword] = useState("");
  const [scope,    setScope]    = useState<Scope>("operate");
  const [expiry,   setExpiry]   = useState("90");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");
  const [created,  setCreated]  = useState<{ name: string; token: string } | null>(null);

  // Creating before the first load finished would invalidate that load and leave the list
  // showing only the new key.
  const [loadedOnce, setLoadedOnce] = useState(false);
  // A reload can overlap a create or revoke; only the newest load may write the list.
  const requestIdRef = useRef(0);
  const id = useId();

  const load = async () => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setLoadError("");
    try {
      const { data, error } = await api.api["api-keys"].get();
      if (requestId !== requestIdRef.current) return;
      if (error) {
        setLoadError((error.value as { error?: string })?.error ?? `HTTP ${error.status}`);
        return;
      }
      setKeys((data as { keys?: ApiKey[] } | null)?.keys ?? []);
      setLoadedOnce(true);
    } catch (e) {
      if (requestId === requestIdRef.current) setLoadError(e instanceof Error ? e.message : "Could not load API keys");
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Closing or reloading the tab would lose a token not yet copied. The app's router has
  // no navigation-blocking hook, so in-app navigation away is not intercepted.
  useEffect(() => {
    if (!created) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [created]);

  const trimmedName = name.trim();
  const atCap = keys.length >= MAX_KEYS;
  // One token on screen at a time: a second create would replace the first unseen.
  const canCreate = loadedOnce && trimmedName.length > 0 && trimmedName.length <= NAME_MAX && password.length > 0
    && !creating && !atCap && !created;

  const create = async () => {
    if (!canCreate) return;
    setCreating(true);
    setCreateError("");
    try {
      const expiresInDays = EXPIRY_OPTIONS.find(o => o.value === expiry)?.days ?? null;
      const { data, error } = await api.api["api-keys"].post({ name: trimmedName, scope, expiresInDays, password });
      if (error) {
        setCreateError((error.value as { error?: string })?.error ?? (error.status === 409
          ? `You already have ${MAX_KEYS} keys. Revoke one first.`
          : "Could not create the key"));
        return;
      }
      const result = data as { key: string; apiKey: ApiKey } | null;
      if (!result) return;
      // A load started before this create would not include the new key.
      ++requestIdRef.current;
      setLoading(false);
      setKeys(prev => [result.apiKey, ...prev.filter(k => k.id !== result.apiKey.id)]);
      setCreated({ name: result.apiKey.name, token: result.key });
      setName("");
      setPassword("");
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : "Could not create the key");
    } finally {
      setCreating(false);
    }
  };

  const revoke = async (k: ApiKey) => {
    setRevokingId(k.id);
    try {
      const { error } = await api.api["api-keys"]({ id: k.id }).delete();
      if (error) {
        useToastStore.getState().push((error.value as { error?: string })?.error ?? "Could not revoke the key", "error");
        return;
      }
      ++requestIdRef.current;
      setLoading(false);
      setKeys(prev => prev.filter(x => x.id !== k.id));
      setConfirmId(null);
      useToastStore.getState().push(`Revoked ${k.name}`, "success");
    } catch (e) {
      useToastStore.getState().push(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setRevokingId(null);
    }
  };

  const anyBusy = revokingId !== null || creating;
  const origin = window.location.origin;
  const th = "px-3 py-2 text-[10px] font-semibold text-gray-500 uppercase tracking-widest whitespace-nowrap";

  const refresh = (
    <button
      type="button"
      onClick={() => void load()}
      disabled={loading}
      aria-label="Refresh API keys"
      className={QUIET_BUTTON}
    >
      <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
      Refresh
    </button>
  );

  return (
    <Section
      title="API keys"
      description="Keys let scripts and other tools call the anpan-os API as you, limited to the key's scope. Revoke a key as soon as it is no longer needed or may have leaked."
      actions={refresh}
    >
      <div className="space-y-5">
        <div className="flex items-start gap-2 px-3 py-2.5 rounded-lg border text-xs text-amber-200 bg-amber-500/10 border-amber-500/25">
          <AlertTriangle size={14} className="text-amber-400 shrink-0 mt-0.5" aria-hidden="true" />
          <p className="leading-relaxed">
            Any key that can write (operate or full) can deploy a compose file, which is root on this
            machine. <strong className="text-amber-100">Treat it like a root password.</strong>
          </p>
        </div>

        {created && (
          <NewKeyPanel name={created.name} token={created.token} onDone={() => setCreated(null)} />
        )}

        {/* ── Existing keys ─────────────────────────────────────────── */}
        <div>
          {loadError && (
            <div role="alert" className="mb-2 px-3 py-2 rounded-lg border text-xs font-medium text-red-400 bg-red-500/10 border-red-500/20">
              {loadError}
            </div>
          )}
          <div className="bg-gray-950 border border-gray-800 rounded-xl overflow-x-auto">
            {loading && keys.length === 0 ? (
              <p className="flex items-center gap-2 px-4 py-6 text-xs text-gray-600">
                <Loader2 size={13} className="animate-spin" /> Loading…
              </p>
            ) : keys.length === 0 ? (
              <p className="px-4 py-6 text-xs text-gray-500">{loadError ? "Use Refresh to try again." : "No API keys yet."}</p>
            ) : (
              <table className="w-full min-w-[44rem] text-left border-collapse">
                <caption className="sr-only">Your API keys ({keys.length})</caption>
                <thead className="border-b border-gray-800">
                  <tr>
                    <th scope="col" className={th}>Name</th>
                    <th scope="col" className={th}>Scope</th>
                    <th scope="col" className={th}>Created</th>
                    <th scope="col" className={th}>Expires</th>
                    <th scope="col" className={th}>Last used</th>
                    <th scope="col" className={`${th} text-right`}><span className="sr-only">Actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  {keys.map(k => (
                    <KeyRow
                      key={k.id}
                      k={k}
                      confirming={confirmId === k.id}
                      busy={revokingId === k.id}
                      anyBusy={anyBusy}
                      onAsk={() => setConfirmId(k.id)}
                      onCancel={() => setConfirmId(null)}
                      onRevoke={() => void revoke(k)}
                    />
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        <div className="grid gap-5 grid-cols-[repeat(auto-fit,minmax(min(100%,24rem),1fr))]">
          {/* ── Create ──────────────────────────────────────────────── */}
          <form
            aria-labelledby={`${id}-create`}
            className="space-y-4"
            onSubmit={e => { e.preventDefault(); void create(); }}
          >
            <h3 id={`${id}-create`} className="text-xs font-semibold text-gray-300">Create a key</h3>

            <div>
              <label htmlFor={`${id}-name`} className={LABEL}>Name</label>
              <input
                id={`${id}-name`}
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                maxLength={NAME_MAX}
                placeholder="e.g. home-assistant, backup script"
                autoComplete="off"
                className={INPUT}
              />
            </div>

            <fieldset>
              <legend className={LABEL}>Scope</legend>
              <div className="space-y-1.5">
                {SCOPES.map(s => (
                  <label
                    key={s.value}
                    className={`flex items-start gap-2.5 px-3 py-2 rounded-lg border cursor-pointer transition-colors ${
                      scope === s.value ? "border-blue-500/60 bg-blue-500/5" : "border-gray-800 hover:border-gray-700"
                    }`}
                  >
                    <input
                      type="radio"
                      name={`${id}-scope`}
                      value={s.value}
                      checked={scope === s.value}
                      onChange={() => setScope(s.value)}
                      className={`mt-0.5 accent-blue-500 ${TARGET} pointer-coarse:mt-0`}
                    />
                    <span className="min-w-0">
                      <span className="block text-sm text-gray-200">{s.label}</span>
                      <span className="block text-[11px] text-gray-500 leading-snug">{s.description}</span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>

            <div>
              <label htmlFor={`${id}-password`} className={LABEL}>Your current password</label>
              <input
                id={`${id}-password`}
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                autoComplete="current-password"
                aria-describedby={`${id}-password-note`}
                className={INPUT}
              />
              <p id={`${id}-password-note`} className="mt-1 text-[11px] text-gray-500">
                Asked every time, because a key keeps working after you sign out. Changing your password revokes every key.
              </p>
            </div>

            <div className="flex items-end gap-3 flex-wrap">
              <div className="w-40">
                <label htmlFor={`${id}-expiry`} className={LABEL}>Expires after</label>
                <select
                  id={`${id}-expiry`}
                  value={expiry}
                  onChange={e => setExpiry(e.target.value)}
                  className={INPUT}
                >
                  {EXPIRY_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </div>
              <div className="flex-1" />
              <button type="submit" disabled={!canCreate} className={`${PRIMARY_BUTTON} py-2 text-sm`}>
                {creating ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />}
                Create key
              </button>
            </div>

            {created && (
              <p className="text-[11px] text-gray-500">Dismiss the new key above before creating another.</p>
            )}
            {atCap && (
              <p className="text-[11px] text-gray-500">You have {MAX_KEYS} keys, the maximum. Revoke one to create another.</p>
            )}
            {createError && (
              <p role="alert" className="text-red-400 text-sm bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">{createError}</p>
            )}
          </form>

          {/* ── Usage ───────────────────────────────────────────────── */}
          <div className="space-y-2 min-w-0">
            <h3 className="text-xs font-semibold text-gray-300">Using a key</h3>
            <p className="text-[11px] text-gray-500">Send it as a bearer token:</p>
            <pre className="text-[11px] font-mono text-gray-300 bg-gray-950 border border-gray-800 rounded-lg px-3 py-2 overflow-x-auto whitespace-pre">
              {`curl -H "Authorization: Bearer $ANPAN_API_KEY" \\\n  ${origin}/api/docker/stacks`}
            </pre>
            <p className="text-[11px] text-gray-500">
              The full API is described at{" "}
              <a href="/api/openapi.json" target="_blank" rel="noopener noreferrer" className="font-mono text-blue-400 hover:text-blue-300 underline">
                /api/openapi.json
              </a>.
            </p>
          </div>
        </div>
      </div>
    </Section>
  );
}
