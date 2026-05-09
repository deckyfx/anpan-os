import { useEffect, useRef, useState } from "react";
import MonacoEditor, { type OnMount } from "@monaco-editor/react";
import { Loader2, Maximize2, Minimize2, Save } from "lucide-react";

// ─── Monaco language map ──────────────────────────────────────────────────────

export function monacoLang(ext: string): string {
  const map: Record<string, string> = {
    ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
    js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
    html: "html", htm: "html", vue: "html", svelte: "html", astro: "html",
    css: "css", scss: "scss", sass: "scss", less: "less",
    json: "json", jsonl: "json",
    yaml: "yaml", yml: "yaml",
    md: "markdown", mdx: "markdown", rst: "markdown",
    rs: "rust", go: "go", py: "python", rb: "ruby", java: "java",
    c: "c", h: "c", cpp: "cpp", hpp: "cpp", cc: "cpp", hh: "cpp", cxx: "cpp",
    cs: "csharp", php: "php", swift: "swift",
    kt: "kotlin", kts: "kotlin", dart: "dart",
    sh: "shell", bash: "shell", zsh: "shell", fish: "shell", cmd: "shell",
    ps1: "powershell", sql: "sql", graphql: "plaintext", gql: "plaintext",
    xml: "xml", plist: "xml", proto: "xml",
    toml: "ini", ini: "ini", cfg: "ini", conf: "ini", env: "ini",
    dockerfile: "dockerfile", lua: "lua", r: "r", scala: "scala",
    hs: "haskell", pl: "perl", ex: "elixir", exs: "elixir",
  };
  return map[ext] ?? "plaintext";
}

// ─── Monaco preview with fullscreen ──────────────────────────────────────────

export interface MonacoPreviewProps {
  ext:             string;
  content:         string;
  onContentChange: (v: string) => void;
  onSave:          () => void;
  saving:          boolean;
  saveMsg:         string;
}

export function MonacoPreview({ ext, content, onContentChange, onSave, saving, saveMsg }: MonacoPreviewProps) {
  const [fullscreen, setFullscreen] = useState(false);
  const onSaveRef = useRef(onSave);
  const savingRef = useRef(saving);
  useEffect(() => { onSaveRef.current = onSave; }, [onSave]);
  useEffect(() => { savingRef.current = saving; }, [saving]);

  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setFullscreen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullscreen]);

  const lang = monacoLang(ext);

  const handleMount: OnMount = (editor, monaco) => {
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      if (!savingRef.current) onSaveRef.current();
    });
  };

  const toolbar = (
    <div className="flex items-center gap-2 px-2 h-10 border-b border-gray-800 bg-gray-900">
      <span className="text-xs text-gray-500 font-mono mr-auto">{lang}</span>
      {saveMsg && (
        <span className={`text-xs ${saveMsg === "Saved" ? "text-green-400" : "text-red-400"}`}>
          {saveMsg}
        </span>
      )}
      <button
        onClick={onSave}
        disabled={saving}
        title="Save (Ctrl+S)"
        aria-label="Save file"
        className="p-1.5 rounded text-gray-400 hover:text-white hover:bg-gray-700 transition-colors disabled:opacity-40"
      >
        {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
      </button>
      <button
        onClick={() => setFullscreen((f) => !f)}
        title={fullscreen ? "Exit fullscreen (Esc)" : "Enter fullscreen"}
        aria-label={fullscreen ? "Exit fullscreen" : "Enter fullscreen"}
        className="p-1.5 rounded text-gray-400 hover:text-white hover:bg-gray-700 transition-colors"
      >
        {fullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
      </button>
    </div>
  );

  if (fullscreen) {
    return (
      <div className="fixed inset-0 z-200 bg-gray-950 flex flex-col">
        {toolbar}
        <div className="flex-1 overflow-hidden">
          <MonacoEditor
            height="calc(100vh - 40px)"
            language={lang}
            value={content}
            onChange={(val) => onContentChange(val ?? "")}
            theme="vs-dark"
            onMount={handleMount}
            options={{ minimap: { enabled: true }, fontSize: 14, lineNumbers: "on", scrollBeyondLastLine: false, wordWrap: "on", automaticLayout: true, padding: { top: 8 } }}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col rounded overflow-hidden border border-gray-800">
      {toolbar}
      <MonacoEditor
        height="62vh"
        language={lang}
        value={content}
        onChange={(val) => onContentChange(val ?? "")}
        theme="vs-dark"
        onMount={handleMount}
        options={{ minimap: { enabled: false }, fontSize: 13, lineNumbers: "on", scrollBeyondLastLine: false, wordWrap: "on", automaticLayout: true, padding: { top: 8 } }}
      />
    </div>
  );
}
