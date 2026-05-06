import React from "react";
import type { Stack } from "./types";

export function BottomBar({ stacks }: { stacks: Stack[] }) {
  const running = stacks.filter((s) => s.state === "running").length;
  const partial = stacks.filter((s) => s.state === "partial").length;
  const stopped = stacks.filter((s) => s.state === "stopped").length;

  const items = [
    running > 0 ? `● ${running} running` : null,
    partial > 0 ? `◑ ${partial} partial` : null,
    stopped > 0 ? `○ ${stopped} stopped` : null,
    stacks.length === 0 ? "No stacks" : null,
  ].filter(Boolean).join("   ·   ");

  return (
    <footer className="h-7 border-t border-gray-800 px-4 flex items-center gap-3 text-[10px] text-gray-600 shrink-0 overflow-hidden select-none">
      <span className="text-gray-700 font-semibold tracking-widest uppercase shrink-0">Status</span>
      <span className="w-px h-3 bg-gray-800 shrink-0" />
      <span className="truncate">{items}</span>
    </footer>
  );
}
