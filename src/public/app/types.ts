export type View = "loading" | "setup" | "login" | "app";

export interface AuthStatus {
  initialized: boolean;
  authenticated: boolean;
}
