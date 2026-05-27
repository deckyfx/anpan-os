import { HardDrive, X } from "lucide-react";
import type { Stack } from "./types";

interface MountPickerDialogProps {
  stack: Stack;
  paths: string[];
  onPick: (path: string) => void;
  onClose: () => void;
}

/**
 * Dialog shown when a stack has multiple host bind-mount paths.
 * The user picks one to open in the File Browser.
 */
export function MountPickerDialog({ stack, paths, onPick, onClose }: MountPickerDialogProps) {
  const title = stack.meta?.title ?? stack.name;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-gray-900 border border-gray-700 rounded-2xl shadow-2xl w-full max-w-md mx-4">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
          <div className="flex items-center gap-2.5">
            <HardDrive size={16} className="text-amber-400 shrink-0" />
            <span className="text-sm font-semibold text-gray-100">Mounted Volumes</span>
            <span className="text-xs text-gray-500 truncate max-w-[160px]">{title}</span>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="text-gray-500 hover:text-white transition-colors p-1 rounded-lg hover:bg-gray-800"
          >
            <X size={16} />
          </button>
        </div>

        {/* Path list */}
        <div className="p-3 flex flex-col gap-1 max-h-72 overflow-y-auto">
          {paths.map((p) => (
            <button
              key={p}
              onClick={() => onPick(p)}
              className="w-full text-left flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-gray-800 transition-colors group"
            >
              <HardDrive size={14} className="text-gray-500 group-hover:text-amber-400 shrink-0 transition-colors" />
              <span className="text-sm text-gray-300 group-hover:text-white font-mono truncate transition-colors">
                {p}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
