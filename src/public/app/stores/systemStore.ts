import { create } from "zustand";
import { api } from "../lib/api";

export interface ToolInfo {
  id:          string;
  name:        string;
  feature:     string;
  binary:      string | undefined;
  /** False when the tool has no role on this platform — absent by design, not missing. */
  applicable:  boolean;
  available:   boolean;
  installHint: string;
}

/**
 * Features the server reports as usable on this host.
 *
 * Mirrors PlatformFeatures in lib/platform. The UI renders against these rather than
 * against a platform string, so adding a platform does not mean revisiting every
 * conditional — and a control that cannot work is absent rather than present-and-broken.
 */
export interface PlatformFeatures {
  casaosMigration: boolean;
  powerControl:    boolean;
  samba:           boolean;
  selfUpdate:      boolean;
}

/** Assume nothing works until the server says otherwise — a missing button is recoverable. */
const NO_FEATURES: PlatformFeatures = {
  casaosMigration: false,
  powerControl:    false,
  samba:           false,
  selfUpdate:      false,
};

interface SystemState {
  /** Process username (whoami). Empty string until loaded. */
  user:    string;
  /** Numeric UID. -1 until loaded. */
  uid:     number;
  /** True when running as root (uid === 0). */
  isRoot:  boolean;
  /** Host OS as reported by the server: "linux" | "darwin" | "win32". */
  platform: string;
  /** Host architecture: "x64" | "arm64". */
  arch:     string;
  /** Human-readable platform, e.g. "macOS (Apple Silicon)". */
  platformLabel: string;
  /** Which platform-gated features this host supports. */
  features: PlatformFeatures;
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
  const [envRes, toolsRes, infoRes] = await Promise.all([
    api.api.system.environment.get(),
    api.api.system.doctor.get(),
    api.api.system.info.get(),
  ]);

  const envData = envRes.data;
  const env = (envData && typeof envData === "object" && "user" in envData)
    ? envData as { user: string; uid: number; isRoot: boolean }
    : null;

  const tools = Array.isArray(toolsRes.data) ? toolsRes.data as ToolInfo[] : [];

  const infoData = infoRes.data;
  const info = (infoData && typeof infoData === "object" && "features" in infoData)
    ? infoData as { platform: string; arch: string; platformLabel: string; features: PlatformFeatures }
    : null;

  return { env, tools, info };
}

export const useSystemStore = create<SystemState>((set, get) => ({
  user:   "",
  uid:    -1,
  isRoot: false,
  platform: "",
  arch:     "",
  platformLabel: "",
  features: NO_FEATURES,
  tools:  [],
  loaded: false,

  hasBin: (id: string) => {
    const tool = get().tools.find(t => t.id === id);
    return tool?.available ?? false;
  },

  load: async () => {
    if (get().loaded) return;
    try {
      const { env, tools, info } = await fetchAll();
      set({
        ...(env ?? {}),
        ...(info ?? {}),
        tools,
        loaded: true,
      });
    } catch {
      set({ loaded: true });
    }
  },

  reload: async () => {
    try {
      const { env, tools, info } = await fetchAll();
      set({
        ...(env ?? {}),
        ...(info ?? {}),
        tools,
        loaded: true,
      });
    } catch { /* keep stale values */ }
  },
}));
