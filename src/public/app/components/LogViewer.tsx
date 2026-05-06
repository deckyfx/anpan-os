import React, { useEffect, useRef } from "react";

export function LogViewer({ logs, className = "" }: { logs: string; className?: string }) {
  const ref = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (ref.current) {
      ref.current.scrollTop = ref.current.scrollHeight;
    }
  }, [logs]);

  return (
    <pre
      ref={ref}
      className={`bg-gray-950 text-green-400 font-mono text-xs p-3 rounded-lg overflow-auto whitespace-pre-wrap break-all ${className}`}
    >
      {logs || "(no output)"}
    </pre>
  );
}
