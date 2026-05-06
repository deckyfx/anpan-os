import React from "react";
import { Dialog } from "../../components/Dialog";
import { LogViewer } from "../../components/LogViewer";
import type { Stack } from "./types";

export function LogsDialog({ stack, logs, loading, open, onClose }: {
  stack: Stack | null;
  logs: string;
  loading: boolean;
  open: boolean;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={open}
      title={stack ? `Logs — ${stack.name}` : "Logs"}
      onClose={onClose}
      size="xl"
      footer={
        <button onClick={onClose} className="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors">
          Close
        </button>
      }
    >
      {loading
        ? <p className="text-gray-500 text-sm animate-pulse py-4">Loading…</p>
        : <LogViewer logs={logs} className="h-[60vh]" />
      }
    </Dialog>
  );
}
