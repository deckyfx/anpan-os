import { create } from "zustand";
import {
  startRegistration,
  startAuthentication,
} from "@simplewebauthn/browser";
import { api } from "../lib/api";
import type { View, AuthStatus } from "../types";

interface LoginMethods {
  form:    boolean;
  passkey: boolean;
}

interface AuthState {
  view:         View;
  username:     string;
  hasPasskey:   boolean | null;   // null = unknown
  loginMethods: LoginMethods;

  checkAuth:        () => Promise<void>;
  /** Called after password login — checks for passkeys, offers setup if none. */
  login:            (username: string) => Promise<void>;
  /** Called after first-time setup — shows passkey offer screen. */
  afterSetup:       (username: string) => void;
  logout:           () => void;
  /** Skip the passkey setup prompt and go to app. */
  skipPasskeySetup: () => void;

  /** Register a new passkey for the currently logged-in user. */
  registerPasskey:  (deviceName?: string) => Promise<void>;
  /** Attempt sign-in with a passkey; returns username on success. */
  loginWithPasskey: () => Promise<string>;
}

async function checkPasskeys(): Promise<boolean> {
  try {
    const { data } = await api.api.auth.passkey.credentials.get();
    return Array.isArray(data) && data.length > 0;
  } catch {
    return true; // assume has passkey on error to avoid repeated prompts
  }
}

async function fetchLoginMethods(): Promise<LoginMethods> {
  try {
    const { data } = await api.api.auth.methods.get();
    if (data && typeof (data as LoginMethods).form === "boolean" && typeof (data as LoginMethods).passkey === "boolean") {
      return data as LoginMethods;
    }
  } catch {
    // ignore — fall through to default
  }
  return { form: true, passkey: true };
}

export const useAuthStore = create<AuthState>((set, get) => ({
  view:         "loading",
  username:     "",
  hasPasskey:   null,
  loginMethods: { form: true, passkey: true },

  checkAuth: async () => {
    try {
      const [statusRes, methods] = await Promise.all([
        api.api.auth.status.get(),
        fetchLoginMethods(),
      ]);
      const { initialized, authenticated } = statusRes.data as AuthStatus;
      set({ loginMethods: methods });
      if (authenticated) {
        const has = await checkPasskeys();
        set({ view: "app", hasPasskey: has });
      } else if (initialized) {
        set({ view: "login" });
      } else {
        set({ view: "setup" });
      }
    } catch {
      set({ view: "login" });
    }
  },

  login: async (username) => {
    set({ username });
    const { loginMethods } = get();
    if (!loginMethods.passkey) {
      // Passkey disabled — skip passkey setup entirely
      set({ hasPasskey: true, view: "app" });
      return;
    }
    const has = await checkPasskeys();
    set({ hasPasskey: has, view: has ? "app" : "passkeySetup" });
  },
  afterSetup:       (username) => set({ view: "passkeySetup", username, hasPasskey: false }),
  logout:           ()         => set({ view: "login",        username: "", hasPasskey: null }),
  skipPasskeySetup: ()         => set({ view: "app" }),

  registerPasskey: async (deviceName) => {
    // 1. Get challenge from server
    const optRes = await api.api.auth.passkey["register-options"].post({});
    if (optRes.error) throw new Error((optRes.error.value as { error?: string })?.error ?? "Failed to get options");
    const { nonce, options } = optRes.data as { nonce: string; options: object };

    // 2. Prompt browser authenticator
    const response = await startRegistration({ optionsJSON: options as Parameters<typeof startRegistration>[0]["optionsJSON"] });

    // 3. Verify with server
    const verRes = await api.api.auth.passkey["register-verify"].post({ nonce, response, deviceName });
    if (verRes.error) throw new Error((verRes.error.value as { error?: string })?.error ?? "Registration failed");
    set({ hasPasskey: true });
  },

  loginWithPasskey: async () => {
    // 1. Get challenge
    const optRes = await api.api.auth.passkey["login-options"].post({});
    if (optRes.error) throw new Error((optRes.error.value as { error?: string })?.error ?? "Failed to get options");
    const { nonce, options } = optRes.data as { nonce: string; options: object };

    // 2. Prompt browser authenticator
    const response = await startAuthentication({ optionsJSON: options as Parameters<typeof startAuthentication>[0]["optionsJSON"] });

    // 3. Verify with server — sets session cookie
    const verRes = await api.api.auth.passkey["login-verify"].post({ nonce, response });
    if (verRes.error) throw new Error((verRes.error.value as { error?: string })?.error ?? "Authentication failed");
    const { username } = verRes.data as { username: string };

    set({ view: "app", username, hasPasskey: true });
    return username;
  },
}));
