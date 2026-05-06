import React from "react";
import { Dialog } from "./Dialog";

interface ConfirmDialogProps {
  open:       boolean;
  title:      string;
  message:    string;
  confirmLabel?: string;
  cancelLabel?:  string;
  danger?:    boolean;
  onConfirm:  () => void;
  onCancel:   () => void;
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel  = "Cancel",
  danger       = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  return (
    <Dialog
      open={open}
      title={title}
      onClose={onCancel}
      footer={
        <>
          <button
            onClick={onCancel}
            className="px-4 py-2 rounded-lg text-sm text-gray-300 hover:text-white hover:bg-gray-800 transition-colors"
          >
            {cancelLabel}
          </button>
          <button
            onClick={onConfirm}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              danger
                ? "bg-red-600 hover:bg-red-700 text-white"
                : "bg-blue-600 hover:bg-blue-700 text-white"
            }`}
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      <p className="text-sm text-gray-300">{message}</p>
    </Dialog>
  );
}
