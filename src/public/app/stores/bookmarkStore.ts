import { create } from "zustand";
import { api } from "../lib/api";
import { useToastStore } from "./toastStore";
import type { Bookmark, BookmarkAction } from "../pages/home/types";

interface BookmarkState {
  bookmarks: Bookmark[];

  addOpen:      boolean;
  editTarget:   Bookmark | null;
  noteTarget:   Bookmark | null;
  deleteTarget: Bookmark | null;

  load:        () => Promise<void>;
  setAddOpen:  (open: boolean) => void;
  setEdit:     (b: Bookmark | null) => void;
  setNote:     (b: Bookmark | null) => void;
  setDelete:   (b: Bookmark | null) => void;
  handleAction:(bookmark: Bookmark, action: BookmarkAction) => void;
  saveNote:    (id: number, note: string | null) => Promise<void>;
  remove:      (id: number) => Promise<void>;
}

export const useBookmarkStore = create<BookmarkState>((set, get) => ({
  bookmarks:    [],
  addOpen:      false,
  editTarget:   null,
  noteTarget:   null,
  deleteTarget: null,

  load: async () => {
    try {
      const { data } = await api.api.bookmarks.get();
      if (data) set({ bookmarks: data as Bookmark[] });
    } catch { /* network error — keep last known list */ }
  },

  setAddOpen:  (addOpen)      => set({ addOpen }),
  setEdit:     (editTarget)   => set({ editTarget }),
  setNote:     (noteTarget)   => set({ noteTarget }),
  setDelete:   (deleteTarget) => set({ deleteTarget }),

  handleAction: (bookmark, action) => {
    if (action === "edit")   { set({ editTarget: bookmark });   return; }
    if (action === "note")   { set({ noteTarget: bookmark });   return; }
    if (action === "delete") { set({ deleteTarget: bookmark }); return; }
  },

  saveNote: async (id, note) => {
    try {
      const { error } = await api.api.bookmarks({ id: String(id) }).patch({ note: note || null });
      if (error) {
        useToastStore.getState().push("Failed to save note", "error");
        return;
      }
      await get().load();
      useToastStore.getState().push("Note saved", "success");
    } catch {
      useToastStore.getState().push("Failed to save note", "error");
    }
  },

  remove: async (id) => {
    try {
      const { error } = await api.api.bookmarks({ id: String(id) }).delete();
      if (error) {
        useToastStore.getState().push("Failed to delete bookmark", "error");
        return;
      }
      await get().load();
      useToastStore.getState().push("Bookmark deleted", "success");
    } catch {
      useToastStore.getState().push("Failed to delete bookmark", "error");
    }
  },
}));
