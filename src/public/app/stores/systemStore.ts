import { create } from "zustand";
import { api } from "../lib/api";

export interface ToolInfo {
  id:          string;
  name:        string;
  feature:     string;
  binary:      string | undefined;
  available:   boolean;
  installHint: string;
}

interface SystemState {
  /** Process username (whoami). Empty string until loaded. */
  user:    string;
  /** Numeric UID. -1 until loaded. */
  uid:     number;
  /** True when running as root (uid === 0). */
  isRoot:  boolean;
  /** All registered external tools and their availability. Empty until loaded. */
  tools:   ToolInfo[];
  /** True once both environment and tool fetches have completed. */
  loaded:  boolean;

  /** Returns true if the named tool id is present on PATH. */
  hasBin:  (id: string) => boolean;

  /** Fetch all info from the server. No-ops if already loaded. */
  load:    () => Promise<void>;
  /** Force a fresh fetch regardless of loaded state. */
  reload:  () => Promise<void>;
}

async function fetchAll() {
  const [envRes, toolsRes] = await Promise.all([
    api.api.system.environment.get(),
    api.api.system.doctor.get(),
  ]);

  const envData = envRes.data;
  const env = (envData && typeof envData === "object" && "user" in envData)
    ? envData as { user: string; uid: number; isRoot: boolean }
    : null;

  const tools = Array.isArray(toolsRes.data) ? toolsRes.data as ToolInfo[] : [];

  return { env, tools };
}

export const useSystemStore = create<SystemState>((set, get) => ({
  user:   "",
  uid:    -1,
  isRoot: false,
  tools:  [],
  loaded: false,

  hasBin: (id: string) => {
    const tool = get().tools.find(t => t.id === id);
    return tool?.available ?? false;
  },

  load: async () => {
    if (get().loaded) return;
    try {
      const { env, tools } = await fetchAll();
      set({
        ...(env ?? {}),
        tools,
        loaded: true,
      });
    } catch {
      set({ loaded: true });
    }
  },

  reload: async () => {
    try {
      const { env, tools } = await fetchAll();
      set({
        ...(env ?? {}),
        tools,
        loaded: true,
      });
    } catch { /* keep stale values */ }
  },
}));
