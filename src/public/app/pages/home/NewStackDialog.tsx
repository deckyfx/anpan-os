import { useEffect, useRef, useState } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import type { editor } from "monaco-editor";
import { Link, Loader2 } from "lucide-react";
import { Dialog } from "../../components/Dialog";
import { api } from "../../lib/api";
import { TemplateBrowser } from "./TemplateBrowser";

interface SSEMsg { log?: string; ok?: boolean; error?: string }

const NAME_RE = /^[a-zA-Z0-9_-]+$/;

const PLACEHOLDER = `services:
  whoami:
    image: traefik/whoami
    ports:
      - "8088:80"
    restart: unless-stopped
`;

export function NewStackDialog({ open, onClose, onInstalled }: {
  open: boolean;
  onClose: () => void;
  onInstalled: () => void;
}) {
  const [name,       setName]       = useState("");
  const [content,    setContent]    = useState(PLACEHOLDER);
  const [busy,       setBusy]       = useState(false);
  const [error,      setError]      = useState("");
  const [fetchUrl,   setFetchUrl]   = useState("");
  const [fetchBusy,  setFetchBusy]  = useState(false);
  const [fetchError, setFetchError] = useState("");
  const [log,        setLog]        = useState<string[]>([]);
  const [tab,        setTab]        = useState<"compose" | "templates" | "log">("compose");

  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const logRef    = useRef<HTMLPreElement | null>(null);

  const handleEditorMount: OnMount = (ed) => { editorRef.current = ed; };

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  const reset = () => {
    setName(""); setContent(""); setError("");
    setFetchUrl(""); setFetchError(""); setBusy(false);
    setLog([]); setTab("compose");
  };
  const handleClose = () => { reset(); onClose(); };

  const handleFetch = async () => {
    const url = fetchUrl.trim();
    if (!url) return;
    setFetchBusy(true);
    setFetchError("");
    try {
      const { data, error } = await api.api.compose.fetch.post({ url });
      if (error) {
        setFetchError((error.value as { error?: string })?.error ?? String(error.status));
        return;
      }
      const text = (data as { content?: string })?.content ?? "";
      setContent(text);
      editorRef.current?.setValue(text);
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : String(err));
    } finally {
      setFetchBusy(false);
    }
  };

  const handleInstall = async () => {
    if (!NAME_RE.test(name)) { setError("Name must be alphanumeric with dashes or underscores only."); return; }
    if (!content.trim())     { setError("Compose content cannot be empty."); return; }
    setBusy(true);
    setError("");
    setLog([]);
    setTab("log");
    try {
      const { data, error: err } = await api.api.compose.stacks.post({ name, content });
      if (err) {
        setError((err.value as { error?: string })?.error ?? "Request failed");
        return;
      }
      for await (const event of data!) {
        const m = event.data as SSEMsg;
        if (m.log !== undefined) {
          setLog(prev => [...prev, m.log!]);
        } else if (m.ok) {
          reset();
          onInstalled();
          onClose();
          return;
        } else if (m.error) {
          setError(m.error);
          return;
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      title="New Stack"
      onClose={handleClose}
      size="2xl"
      notification={error ? (
        <p className="text-red-400 text-sm bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2 whitespace-pre-wrap">
          {error}
        </p>
      ) : undefined}
      footer={
        <>
          <button onClick={handleClose} className="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors">
            Cancel
          </button>
          <button
            onClick={handleInstall}
            disabled={busy}
            className="px-4 py-2 text-sm bg-amber-500 hover:bg-amber-400 text-black font-semibold rounded-lg transition-colors disabled:opacity-50"
          >
            {busy ? <><Loader2 size={13} className="inline animate-spin mr-1" />Installing…</> : "Install"}
          </button>
        </>
      }
    >
      <div className="space-y-4">

        {/* Stack name + URL fetcher in one row */}
        <div className="flex gap-3 items-end">
          <div className="w-48 shrink-0">
            <label className="block text-xs text-gray-500 mb-1.5 uppercase tracking-widest font-semibold">Stack name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="my-stack"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-amber-500"
            />
          </div>
          <div className="flex-1">
            <label className="block text-xs text-gray-500 mb-1.5 uppercase tracking-widest font-semibold">Fetch from URL</label>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Link size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 pointer-events-none" />
                <input
                  type="url"
                  value={fetchUrl}
                  onChange={(e) => setFetchUrl(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") void handleFetch(); }}
                  placeholder="https://raw.githubusercontent.com/…/docker-compose.yml"
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg pl-8 pr-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-amber-500"
                />
              </div>
              <button
                onClick={() => void handleFetch()}
                disabled={fetchBusy || !fetchUrl.trim()}
                className="flex items-center gap-1.5 px-4 py-2 text-sm bg-gray-700 hover:bg-gray-600 text-gray-200 rounded-lg transition-colors disabled:opacity-40 shrink-0"
              >
                {fetchBusy ? <><Loader2 size={13} className="animate-spin" /> Fetching…</> : "Fetch"}
              </button>
            </div>
            {fetchError && <p className="mt-1.5 text-red-400 text-xs">{fetchError}</p>}
          </div>
        </div>

        {/* Tab bar */}
        <div className="flex items-center gap-1 border-b border-gray-700">
          {(["compose", "templates", "log"] as const).filter(t => !busy || t !== "templates").map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-4 py-1.5 text-xs font-medium rounded-t-md transition-colors
                ${tab === t
                  ? "bg-gray-800 text-white border border-b-0 border-gray-700"
                  : "text-gray-500 hover:text-gray-300"
                }`}
            >
              {t === "compose" ? "docker-compose.yml" : t === "templates" ? "Browse templates" : "Install log"}
            </button>
          ))}
        </div>

        {/* Template browser */}
        {tab === "templates" && (
          <TemplateBrowser
            onSelect={(yaml, tplName, defaultPort) => {
              setContent(yaml);
              editorRef.current?.setValue(yaml);
              if (!name.trim()) setName(tplName.toLowerCase().replace(/\s+/g, "-"));
              void defaultPort; // stored in meta at install time
              setTab("compose");
            }}
          />
        )}

        {/* Editor — hidden when not on compose tab, kept mounted to preserve content */}
        <div style={{ display: tab === "compose" ? "block" : "none" }}>
          <div className="rounded-lg overflow-hidden border border-gray-700">
            <Editor
              height="360px"
              defaultLanguage="yaml"
              theme="vs-dark"
              value={content}
              onMount={handleEditorMount}
              onChange={(val) => setContent(val ?? "")}
              loading={
                <div className="h-96 bg-[#1e1e1e] flex items-center justify-center text-gray-600 text-sm">
                  Loading editor…
                </div>
              }
              options={{
                minimap:              { enabled: false },
                fontSize:             13,
                lineNumbers:          "on",
                scrollBeyondLastLine: false,
                wordWrap:             "off",
                tabSize:              2,
                insertSpaces:         true,
                renderLineHighlight:  "line",
                padding:              { top: 12, bottom: 12 },
                scrollbar:            { verticalScrollbarSize: 6, horizontalScrollbarSize: 6 },
              }}
            />
          </div>
        </div>

        {/* Log panel — same height as editor */}
        {tab === "log" && (
          <pre
            ref={logRef}
            className="h-90 bg-black rounded-lg border border-gray-700 p-3 text-xs text-green-400 font-mono overflow-y-auto whitespace-pre-wrap"
          >
            {log.length === 0
              ? <span className="text-gray-600">Waiting for output…</span>
              : log.join("\n")
            }
          </pre>
        )}

      </div>
    </Dialog>
  );
}
