import { useEffect, useRef, useState } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import type { editor } from "monaco-editor";
import { Loader2 } from "lucide-react";
import { Dialog } from "../../components/Dialog";
import { api } from "../../lib/api";
import type { Stack } from "./types";

interface SSEMsg { log?: string; ok?: boolean; error?: string }

export function EditStackDialog({ stack, open, onClose, onSaved }: {
  stack: Stack | null;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  if (!open || !stack) return null;
  return <EditStackDialogInner key={stack.name} stack={stack} onClose={onClose} onSaved={onSaved} />;
}

function EditStackDialogInner({ stack, onClose, onSaved }: {
  stack: Stack;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [content,  setContent]  = useState("");
  const [loading,  setLoading]  = useState(true);
  const [busy,     setBusy]     = useState(false);
  const [error,    setError]    = useState("");
  const [log,      setLog]      = useState<string[]>([]);
  const [tab,      setTab]      = useState<"compose" | "log">("compose");

  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const logRef    = useRef<HTMLPreElement | null>(null);

  const handleEditorMount: OnMount = (ed) => { editorRef.current = ed; };

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  // Fetch current compose file on mount
  useState(() => {
    void (async () => {
      try {
        const { data, error: err } = await api.api.compose.stacks({ name: stack.name }).file.get();
        if (err) {
          setError((err.value as { error?: string })?.error ?? "Failed to load compose file");
          return;
        }
        const text = data as unknown as string;
        setContent(text);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load compose file");
      } finally {
        setLoading(false);
      }
    })();
  });

  const handleSave = async () => {
    if (!content.trim()) { setError("Compose content cannot be empty."); return; }
    setBusy(true);
    setError("");
    setLog([]);
    setTab("log");
    try {
      const { data, error: err } = await api.api.compose.stacks({ name: stack.name }).file.put({ content });
      if (err) {
        setError((err.value as { error?: string })?.error ?? "Request failed");
        setTab("compose");
        return;
      }
      for await (const event of data!) {
        const m = event.data as SSEMsg;
        if (m.log !== undefined) {
          setLog(prev => [...prev, m.log!]);
        } else if (m.ok) {
          onSaved();
          onClose();
          return;
        } else if (m.error) {
          setError(m.error);
          setTab("compose");
          return;
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setTab("compose");
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
        onClick={() => void handleSave()}
        disabled={busy || loading}
        className="px-4 py-2 text-sm bg-amber-500 hover:bg-amber-400 text-black font-semibold rounded-lg transition-colors disabled:opacity-50"
      >
        {busy ? <><Loader2 size={13} className="inline animate-spin mr-1" />Deploying…</> : "Save & Deploy"}
      </button>
    </>
  );

  return (
    <Dialog
      open
      title={`Edit Compose — ${stack.meta?.title ?? stack.name}`}
      onClose={onClose}
      size="2xl"
      notification={error ? (
        <p className="text-red-400 text-sm bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2 whitespace-pre-wrap">
          {error}
        </p>
      ) : undefined}
      footer={footer}
    >
      <div className="space-y-4">
        {/* Tab bar */}
        <div className="flex items-center gap-1 border-b border-gray-700">
          {(["compose", "log"] as const).map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-4 py-1.5 text-xs font-medium rounded-t-md transition-colors
                ${tab === t
                  ? "bg-gray-800 text-white border border-b-0 border-gray-700"
                  : "text-gray-500 hover:text-gray-300"
                }`}
            >
              {t === "compose" ? "docker-compose.yml" : "Deploy log"}
            </button>
          ))}
        </div>

        {/* Editor — hidden when log tab, kept mounted to preserve edits */}
        <div style={{ display: tab === "compose" ? "block" : "none" }}>
          {loading ? (
            <div className="h-[360px] bg-[#1e1e1e] rounded-lg border border-gray-700 flex items-center justify-center text-gray-600 text-sm">
              <Loader2 size={18} className="animate-spin mr-2" /> Loading compose file…
            </div>
          ) : (
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
          )}
        </div>

        {/* Deploy log panel */}
        {tab === "log" && (
          <pre
            ref={logRef}
            className="h-[360px] bg-black rounded-lg border border-gray-700 p-3 text-xs text-green-400 font-mono overflow-y-auto whitespace-pre-wrap"
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
