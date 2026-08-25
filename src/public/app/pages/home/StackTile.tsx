import React, { useState } from "react";
import {
  Play, Square, RotateCw, ScrollText, StickyNote,
  Settings2, FileDown, PackagePlus, Trash2,
  MoreVertical, GripVertical, ExternalLink,
  Pencil, RefreshCcw, ArrowRightLeft, HardDrive, ArrowUp, RefreshCw } from "lucide-react";
import type { ComposeOrigin, Stack, StackAction } from "./types";
import { buildLaunchUrl, launchLabel, stackStateColor } from "./utils";
import { useSystemStore } from "../../stores/systemStore";
import { useUpdateCheckStore } from "../../stores/updateCheckStore";

const ORIGIN_LABEL: Record<NonNullable<ComposeOrigin>, string> = {
  managed: "⚙ Managed",
  casaos:  "🏠 CasaOS",
};

// ─── Tile context menu ────────────────────────────────────────────────────────

interface TileMenuProps {
  stack: Stack;
  onAction: (action: StackAction) => void;
  onClose: () => void;
}

/** Floating context menu rendered inside the tile's relative container. */
function TileMenu({ stack, onAction, onClose }: TileMenuProps) {
  const allRunning = stack.state === "running";
  const allStopped = stack.state === "stopped";
  const act = (a: StackAction) => { onAction(a); onClose(); };
  const { isRoot, features } = useSystemStore();

  const item = "w-full flex items-center gap-2.5 px-3 py-1.5 rounded-lg hover:bg-gray-700 text-gray-200 transition-colors";

  return (
    <>
      <div className="fixed inset-0 z-10" onClick={onClose} />
      <div
        className="absolute top-8 right-0 z-20 w-60 bg-gray-800 border border-gray-700 rounded-xl shadow-2xl p-1 text-sm"
      >
      {!allRunning && (
        <button className={item} onClick={() => act("start")}>
          <Play size={14} className="text-green-400 shrink-0" /> Start
        </button>
      )}
      {!allStopped && (
        <button className={item} onClick={() => act("stop")}>
          <Square size={14} className="text-amber-400 shrink-0" /> Stop
        </button>
      )}
      <button className={item} onClick={() => act("restart")}>
        <RotateCw size={14} className="text-sky-400 shrink-0" /> Restart
      </button>
      {stack.origin === "managed" && (
        <button className={item} onClick={() => act("guided-edit")}>
          <Pencil size={14} className="text-amber-400 shrink-0" /> Edit
        </button>
      )}

      <div className="border-t border-gray-700 my-1 mx-1" />

      <button className={item} onClick={() => act("check-updates")}>
        <RefreshCw size={14} className="text-sky-400 shrink-0" /> Check for updates
      </button>
      <button className={item} onClick={() => act("logs")}>
        <ScrollText size={14} className="text-gray-400 shrink-0" /> View Logs
      </button>
      <button className={item} onClick={() => act("note")}>
        <StickyNote size={14} className={stack.meta?.note ? "text-amber-400 shrink-0" : "text-gray-400 shrink-0"} />
        Note
        {stack.meta?.note
          ? <span className="ml-auto w-1.5 h-1.5 rounded-full bg-amber-400" />
          : null}
      </button>
      <button className={item} onClick={() => act("detail")}>
        <Settings2 size={14} className="text-gray-400 shrink-0" /> Stack Detail
      </button>
      {stack.origin !== null && (
        <button className={item} onClick={() => act("pull-update")}>
          <RefreshCcw size={14} className="text-sky-400 shrink-0" /> Pull update
        </button>
      )}
      <button className={item} onClick={() => act("browse-mounts")}>
        <HardDrive size={14} className="text-gray-400 shrink-0" /> Browse Mounted Volumes
      </button>
      <button className={item} onClick={() => act("download-compose")}>
        <FileDown size={14} className="text-gray-400 shrink-0" /> Download Compose File
      </button>
      {/* CasaOS only runs on Linux, so on any other host there is nothing to import from
          and these would fail on click. See PlatformFeatures in the system store. */}
      {features.casaosMigration && (
        <>
          <button className={`${item} text-gray-500 text-xs`} onClick={() => act("casaos-import")}>
            <PackagePlus size={13} className="text-gray-500 shrink-0" /> Import from CasaOS
          </button>
          {stack.origin === "casaos" && isRoot && (
            <button className={item} onClick={() => act("migrate-casaos")}>
              <ArrowRightLeft size={13} className="text-sky-400 shrink-0" /> Migrate to anpan-os
            </button>
          )}
        </>
      )}

      <div className="border-t border-gray-700 my-1 mx-1" />

      <button
        className="w-full flex items-center gap-2.5 px-3 py-1.5 rounded-lg hover:bg-red-900/40 text-red-400 transition-colors"
        onClick={() => act("delete")}
      >
        <Trash2 size={14} className="shrink-0" /> Delete Stack…
      </button>
      </div>
    </>
  );
}

// ─── Stack tile ───────────────────────────────────────────────────────────────

export interface StackTileProps {
  stack: Stack;
  actionLoading: boolean;
  onAction: (action: StackAction) => void;
  dragging: boolean;
  dragOver: boolean;
  dragEnabled: boolean;
  onDragStart: () => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: () => void;
  onDragEnd: () => void;
}

/**
 * Grid tile representing a single Docker Compose stack.
 *
 * Shows the app icon, name, service count, launch link, and origin badge.
 * A colored status dot overlays the bottom-right of the icon; the action menu
 * button sits exclusively at top-right and is revealed on hover.
 * An amber update badge overlays the top-left of the icon when an image update
 * is available for this stack.
 * Supports drag-and-drop reordering when `dragEnabled` is true.
 */
export function StackTile({
  stack, actionLoading, onAction,
  dragging, dragOver, dragEnabled,
  onDragStart, onDragOver, onDrop, onDragEnd,
}: StackTileProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const launchUrl   = buildLaunchUrl(stack);
  const title       = stack.meta?.title ?? stack.name;
  const icon        = stack.meta?.icon ?? stack.icon ?? null;
  const initial     = stack.name.charAt(0).toUpperCase();
  const hasUpdate   = useUpdateCheckStore(s => s.hasUpdateFor(stack.name));

  return (
    <div
      className={`relative group transition-all duration-150
        ${dragging ? "opacity-40 scale-95" : ""}
        ${dragOver  ? "ring-2 ring-amber-500 rounded-2xl" : ""}
      `}
      draggable={dragEnabled}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
    >
      <div
        onClick={() => launchUrl && window.open(launchUrl, "_blank", "noopener")}
        className={`bg-gray-900 border border-gray-800 rounded-2xl p-5 flex flex-col items-center gap-3 transition-all select-none
          ${launchUrl ? "cursor-pointer hover:border-gray-600 hover:bg-gray-800/60 hover:scale-[1.02]" : "cursor-default"}
          ${actionLoading ? "opacity-40 pointer-events-none" : ""}
        `}
      >
        {dragEnabled && (
          <div className="absolute top-2 left-2 text-gray-700 cursor-grab active:cursor-grabbing opacity-0 group-hover:opacity-100 transition-opacity select-none">
            <GripVertical size={14} />
          </div>
        )}

        {/* Icon with status dot (bottom-right) and update badge (top-left) overlaid */}
        <div className="relative w-16 h-16 shrink-0">
          <div className="w-full h-full rounded-2xl bg-gray-800 border border-gray-700 flex items-center justify-center overflow-hidden">
            {icon
              ? <img src={icon} alt={title} className="w-full h-full object-contain p-1" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
              : <span className="text-3xl font-bold text-gray-200">{initial}</span>
            }
          </div>

          {/* Status dot — bottom-right of icon, always visible */}
          <span
            title={`Status: ${stack.state}`}
            className={`absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-gray-900 ${stackStateColor[stack.state]} ${stack.state === "partial" ? "animate-pulse" : ""}`}
          />

          {/* Update available badge — top-left of icon */}
          {hasUpdate && (
            <span
              title="Image update available"
              className="absolute -top-1 -left-1 w-4 h-4 rounded-full bg-amber-500 border-2 border-gray-900 flex items-center justify-center"
            >
              <ArrowUp size={8} className="text-black" strokeWidth={3} />
            </span>
          )}
        </div>

        <div className="w-full text-center space-y-1">
          <p className="text-sm text-gray-100 font-medium truncate">{title}</p>
          <p className="text-[10px] text-gray-600">
            {stack.services.length === 1 ? "1 service" : `${stack.services.length} services`}
          </p>
          {launchUrl && (
            <a
              href={launchUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="inline-flex items-center gap-1 text-[10px] text-amber-400 hover:text-amber-300 hover:underline"
            >
              <ExternalLink size={10} /> Open {launchLabel(launchUrl)}
            </a>
          )}
          {stack.origin && (
            <div className="flex justify-center">
              <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-gray-800 text-gray-500 leading-none">
                {ORIGIN_LABEL[stack.origin]}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Menu button — top-right corner, revealed on hover */}
      <button
        className="absolute top-2 right-2 text-gray-600 hover:text-gray-200 opacity-0 group-hover:opacity-100 transition-opacity w-6 h-6 flex items-center justify-center rounded-lg hover:bg-gray-700"
        onClick={(e) => { e.stopPropagation(); setMenuOpen((v) => !v); }}
        aria-label="More options"
      >
        <MoreVertical size={14} />
      </button>

      {menuOpen && (
        <TileMenu stack={stack} onAction={onAction} onClose={() => setMenuOpen(false)} />
      )}
    </div>
  );
}
