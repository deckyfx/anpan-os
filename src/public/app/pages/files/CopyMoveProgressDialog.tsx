import { useEffect, useRef } from "react";
import { useFileStore } from "../../stores/fileStore";

/**
 * SSE streaming progress dialog for copy / move operations.
 * Reads `copyMoveProgress` from the file store and renders a fixed overlay
 * with a scrollable log pane that auto-scrolls on each new line.
 */
export function CopyMoveProgressDialog() {
  const { copyMoveProgress, setCopyMoveProgress } = useFileStore();
  const logRef = useRef<HTMLPreElement>(null);

  // Auto-scroll log to bottom on new lines.
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [copyMoveProgress?.logs.length]);

  if (!copyMoveProgress) return null;
  const { title, logs, done, error } = copyMoveProgress;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="w-full max-w-lg bg-gray-900 border border-gray-700 rounded-xl shadow-2xl flex flex-col max-h-[80vh]">
        <div className="px-5 py-4 border-b border-gray-800 shrink-0">
          <h2 className="text-base font-semibold text-white">{title}</h2>
        </div>

        <pre
          ref={logRef}
          className="flex-1 overflow-y-auto px-5 py-4 text-xs text-gray-300 font-mono whitespace-pre-wrap break-all min-h-32"
        >
          {logs.join("\n")}
          {!done && <span className="animate-pulse text-blue-400">▋</span>}
        </pre>

        {error && (
          <div className="px-5 py-2 text-sm text-red-400 border-t border-gray-800 shrink-0">
            {error}
          </div>
        )}

        {done && (
          <div className="px-5 py-3 border-t border-gray-800 flex justify-end shrink-0">
            <button
              onClick={() => setCopyMoveProgress(null)}
              className="px-4 py-2 rounded-lg text-sm bg-gray-700 hover:bg-gray-600 text-white transition-colors"
            >
              Done
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
