import { useEffect, useRef } from "react";
import { useFileStore } from "../../stores/fileStore";

/**
 * SSE streaming progress dialog for copy / move operations.
 * Reads `opProgress` from the file store and renders a fixed overlay
 * with a scrollable log pane that auto-scrolls on each new line.
 */
export function OperationProgressDialog() {
  const { opProgress, setOpProgress } = useFileStore();
  const logRef = useRef<HTMLPreElement>(null);

  // Auto-scroll log to bottom on new lines.
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [opProgress?.logs.length]);

  if (!opProgress) return null;
  const { title, logs, done, error, percent, onReplace } = opProgress;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="w-full max-w-lg bg-gray-900 border border-gray-700 rounded-xl shadow-2xl flex flex-col max-h-[80vh]">
        <div className="px-5 py-4 border-b border-gray-800 shrink-0">
          <h2 className="text-base font-semibold text-white">{title}</h2>
        </div>

        {/* Only operations that can measure themselves get a bar; copy and move can only
            log, and a fake bar there would misreport progress it does not know. */}
        {percent !== undefined && !error && (
          <div className="px-5 pt-4 shrink-0">
            <div className="flex items-center justify-between text-xs text-gray-400 mb-1.5">
              <span>{done ? "Complete" : "Converting…"}</span>
              <span className="font-mono">{percent}%</span>
            </div>
            <div
              className="h-1.5 w-full rounded-full bg-gray-800 overflow-hidden"
              role="progressbar"
              aria-valuenow={percent}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={title}
            >
              <div
                className={`h-full rounded-full transition-all duration-300 ${done ? "bg-green-500" : "bg-blue-500"}`}
                style={{ width: `${percent}%` }}
              />
            </div>
          </div>
        )}

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
          <div className="px-5 py-3 border-t border-gray-800 flex justify-end gap-2 shrink-0">
            {onReplace && (
              <button
                onClick={onReplace}
                className="px-4 py-2 rounded-lg text-sm bg-amber-600 hover:bg-amber-500 text-white transition-colors"
              >
                Replace existing file
              </button>
            )}
            <button
              onClick={() => setOpProgress(null)}
              className="px-4 py-2 rounded-lg text-sm bg-gray-700 hover:bg-gray-600 text-white transition-colors"
            >
              {onReplace ? "Cancel" : "Done"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
