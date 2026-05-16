import React, { useState, useEffect, useRef } from "react";
import { Dialog }    from "../../components/Dialog";
import { LogViewer } from "../../components/LogViewer";
import { api }       from "../../lib/api";
import type { Stack } from "./types";

interface ContainerInfo {
  name:    string;
  service: string;
  state:   string;
  status:  string;
}

interface SSEMsg { log?: string; error?: string }

const STATE_DOT: Record<string, string> = {
  running: "bg-green-500",
  exited:  "bg-red-500",
  paused:  "bg-yellow-500",
};

/** Stream docker logs for one container, appending lines to `onLine`. Returns a cleanup function. */
function startLogStream(
  stackName: string,
  containerName: string,
  onLine: (line: string) => void,
  onError: (msg: string) => void,
): () => void {
  let cancelled = false;

  void (async () => {
    try {
      const { data, error } = await (
        api.api.compose.stacks({ name: stackName })
          .containers({ container: containerName })
          .logs.get() as unknown as Promise<{ data: AsyncIterable<{ data: SSEMsg }> | null; error: unknown }>
      );
      if (error || !data) {
        if (!cancelled) onError("Failed to connect to log stream");
        return;
      }
      for await (const event of data) {
        if (cancelled) break;
        const m = event.data as SSEMsg;
        if (m.log !== undefined) onLine(m.log);
        else if (m.error)        onError(m.error);
      }
    } catch {
      if (!cancelled) onError("Log stream disconnected");
    }
  })();

  return () => { cancelled = true; };
}

export function ContainerLogsDialog({ stack, open, onClose }: {
  stack:   Stack | null;
  open:    boolean;
  onClose: () => void;
}) {
  const [containers,  setContainers]  = useState<ContainerInfo[]>([]);
  const [loading,     setLoading]     = useState(false);
  const [activeTab,   setActiveTab]   = useState<string | null>(null);
  const [logs,        setLogs]        = useState<string>("");
  const [streamErr,   setStreamErr]   = useState<string | null>(null);

  const cleanupRef = useRef<(() => void) | null>(null);

  // Fetch container list when dialog opens
  useEffect(() => {
    if (!open || !stack) return;
    setContainers([]);
    setActiveTab(null);
    setLogs("");
    setStreamErr(null);
    setLoading(true);

    void (async () => {
      try {
        const { data, error } = await api.api.compose.stacks({ name: stack.name }).containers.get();
        if (error || !data) {
          setStreamErr("Failed to list containers");
          return;
        }
        const list = data as ContainerInfo[];
        setContainers(list);
        // Auto-select first running container, or just first
        const first = list.find(c => c.state === "running") ?? list[0] ?? null;
        setActiveTab(first?.name ?? null);
      } finally {
        setLoading(false);
      }
    })();
  }, [open, stack]);

  // Start/restart log stream when active tab changes
  useEffect(() => {
    cleanupRef.current?.();
    cleanupRef.current = null;
    setLogs("");
    setStreamErr(null);

    if (!open || !stack || !activeTab) return;

    const stop = startLogStream(
      stack.name,
      activeTab,
      (line) => setLogs(prev => prev ? prev + "\n" + line : line),
      (err)  => setStreamErr(err),
    );
    cleanupRef.current = stop;

    return () => {
      stop();
      cleanupRef.current = null;
    };
  }, [open, stack, activeTab]);

  // Stop stream when dialog closes
  useEffect(() => {
    if (!open) {
      cleanupRef.current?.();
      cleanupRef.current = null;
    }
  }, [open]);

  const title = stack ? `Logs — ${stack.name}` : "Logs";

  return (
    <Dialog
      open={open}
      title={title}
      onClose={onClose}
      size="xl"
      footer={
        <button onClick={onClose} className="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors">
          Close
        </button>
      }
    >
      {loading ? (
        <p className="text-gray-500 text-sm animate-pulse py-4">Loading containers…</p>
      ) : containers.length === 0 ? (
        <p className="text-gray-500 text-sm py-4">No containers found for this stack.</p>
      ) : (
        <div className="flex flex-col gap-3">
          {/* Tab bar */}
          <div className="flex flex-wrap gap-1 border-b border-gray-800 pb-2">
            {containers.map(c => {
              const isActive = activeTab === c.name;
              const dot = STATE_DOT[c.state] ?? "bg-gray-500";
              return (
                <button
                  key={c.name}
                  onClick={() => setActiveTab(c.name)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                    isActive
                      ? "bg-amber-500 text-black"
                      : "text-gray-400 hover:text-white hover:bg-gray-800"
                  }`}
                >
                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${isActive ? "bg-black/50" : dot}`} />
                  {c.service || c.name}
                </button>
              );
            })}
          </div>

          {/* Active container name + status */}
          {activeTab && (() => {
            const c = containers.find(x => x.name === activeTab);
            return c ? (
              <p className="text-[10px] text-gray-600 font-mono">{c.name} · {c.status}</p>
            ) : null;
          })()}

          {/* Log viewer */}
          {streamErr ? (
            <p className="text-red-400 text-xs py-2">{streamErr}</p>
          ) : (
            <LogViewer logs={logs} className="h-[60vh]" />
          )}
        </div>
      )}
    </Dialog>
  );
}
