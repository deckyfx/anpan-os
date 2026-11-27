export type View = "loading" | "setup" | "login" | "app" | "passkeySetup";

export interface AuthStatus {
  initialized: boolean;
  authenticated: boolean;
  /** The signed-in user's name, when the server reports it. */
  username?: string | null;
  /** Versioned URL of the signed-in user's avatar, or null when none is set. */
  avatarUrl?: string | null;
}
