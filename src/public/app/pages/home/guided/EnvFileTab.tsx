import Editor from "@monaco-editor/react";

interface Props {
  value:    string;
  onChange: (v: string) => void;
}

const EDITOR_OPTIONS = {
  minimap:              { enabled: false },
  fontSize:             13,
  lineNumbers:          "on" as const,
  scrollBeyondLastLine: false,
  wordWrap:             "off" as const,
  tabSize:              2,
  insertSpaces:         true,
  renderLineHighlight:  "line" as const,
  padding:              { top: 12, bottom: 12 },
  scrollbar:            { verticalScrollbarSize: 6, horizontalScrollbarSize: 6 },
};

export function EnvFileTab({ value, onChange }: Props) {
  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="px-1 pb-3">
        <p className="text-xs text-gray-500 leading-relaxed">
          This <span className="font-mono text-gray-400">.env</span> file is used by Docker Compose for variable substitution in{" "}
          <span className="font-mono text-gray-400">docker-compose.yml</span> (<span className="font-mono text-gray-400">{"${VAR}"}</span>).
          It is separate from container environment variables set in each service.
        </p>
      </div>
      <div className="flex-1 min-h-0 rounded-lg overflow-hidden border border-gray-700">
        <Editor
          height="100%"
          defaultLanguage="ini"
          theme="vs-dark"
          value={value}
          onChange={val => onChange(val ?? "")}
          loading={
            <div className="h-full bg-[#1e1e1e] flex items-center justify-center text-gray-600 text-sm">
              Loading editor…
            </div>
          }
          options={EDITOR_OPTIONS}
        />
      </div>
    </div>
  );
}
