export type View = "loading" | "setup" | "login" | "app" | "passkeySetup";

export interface AuthStatus {
  initialized: boolean;
  authenticated: boolean;
}
