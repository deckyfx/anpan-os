import React, { useRef, useState } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import type { editor } from "monaco-editor";
import { Link, Loader2 } from "lucide-react";
import { Dialog } from "../../components/Dialog";

const NAME_RE = /^[a-zA-Z0-9_-]+$/;

const PLACEHOLDER = `services:
  myservice:
    image: nginx:alpine
    ports:
      - "8080:80"
    restart: unless-stopped
`;

export function NewStackDialog({ open, onClose, onInstalled }: {
  open: boolean;
  onClose: () => void;
  onInstalled: () => void;
}) {
  const [name,        setName]        = useState("");
  const [content,     setContent]     = useState("");
  const [busy,        setBusy]        = useState(false);
  const [error,       setError]       = useState("");
  const [fetchUrl,    setFetchUrl]    = useState("");
  const [fetchBusy,   setFetchBusy]   = useState(false);
  const [fetchError,  setFetchError]  = useState("");

  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);

  const handleEditorMount: OnMount = (ed) => {
    editorRef.current = ed;
  };

  const reset = () => {
    setName(""); setContent(""); setError("");
    setFetchUrl(""); setFetchError(""); setBusy(false);
  };
  const handleClose = () => { reset(); onClose(); };

  const handleFetch = async () => {
    const url = fetchUrl.trim();
    if (!url) return;
    setFetchBusy(true);
    setFetchError("");
    try {
      const res = await fetch(`/api/compose/fetch?url=${encodeURIComponent(url)}`);
      const text = await res.text();
      if (!res.ok) {
        // Try to parse as JSON error
        try {
          const d = JSON.parse(text) as { error?: string };
          setFetchError(d.error ?? `Error ${res.status}`);
        } catch {
          setFetchError(`Error ${res.status}`);
        }
        return;
      }
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
    try {
      const res  = await fetch("/api/compose/stacks", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ name, content }),
      });
      const data = await res.json() as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        setError(data.error ?? `Server error ${res.status}`);
      } else {
        reset();
        onInstalled();
        onClose();
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
            {busy ? "Installing…" : "Install"}
          </button>
        </>
      }
    >
      <div className="space-y-4">

        {/* Stack name */}
        <div>
          <label className="block text-xs text-gray-500 mb-1.5 uppercase tracking-widest font-semibold">Stack name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="my-stack"
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-amber-500"
          />
        </div>

        {/* URL fetcher */}
        <div>
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
              {fetchBusy
                ? <><Loader2 size={13} className="animate-spin" /> Fetching…</>
                : "Fetch"}
            </button>
          </div>
          {fetchError && (
            <p className="mt-1.5 text-red-400 text-xs">{fetchError}</p>
          )}
        </div>

        {/* Monaco editor */}
        <div>
          <label className="block text-xs text-gray-500 mb-1.5 uppercase tracking-widest font-semibold">docker-compose.yml</label>
          <div className="rounded-lg overflow-hidden border border-gray-700">
            <Editor
              height="480px"
              defaultLanguage="yaml"
              theme="vs-dark"
              value={content}
              defaultValue={PLACEHOLDER}
              onMount={handleEditorMount}
              onChange={(val) => setContent(val ?? "")}
              loading={
                <div className="h-120 bg-[#1e1e1e] flex items-center justify-center text-gray-600 text-sm">
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

        {error && (
          <p className="text-red-400 text-sm bg-red-500/10 border border-red-500/20 rounded-lg p-3 whitespace-pre-wrap">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
