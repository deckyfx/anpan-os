import { create } from "zustand";

export type ToastType = "success" | "error" | "info";

export interface Toast {
  id:      string;
  message: string;
  type:    ToastType;
}

interface ToastState {
  toasts:  Toast[];
  push:    (message: string, type?: ToastType) => void;
  dismiss: (id: string) => void;
}

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],

  push: (message, type = "success") => {
    const id = `t-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    set((s) => ({ toasts: [...s.toasts, { id, message, type }] }));
    const ms = type === "error" ? 6000 : 3000;
    setTimeout(
      () => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
      ms,
    );
  },

  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));
