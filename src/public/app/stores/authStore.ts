import { create } from "zustand";
import { api } from "../lib/api";
import type { View, AuthStatus } from "../types";

interface AuthState {
  view:     View;
  username: string;

  checkAuth: () => Promise<void>;
  login:     (username: string) => void;
  logout:    () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  view:     "loading",
  username: "",

  checkAuth: async () => {
    try {
      const { data } = await api.api.auth.status.get();
      const { initialized, authenticated } = data as AuthStatus;
      if (authenticated) set({ view: "app" });
      else if (initialized) set({ view: "login" });
      else set({ view: "setup" });
    } catch {
      set({ view: "login" });
    }
  },

  login:  (username) => set({ view: "app", username }),
  logout: ()         => set({ view: "login", username: "" }),
}));
