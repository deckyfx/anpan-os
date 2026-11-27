import { api } from "./api";
import { useAuthStore } from "../stores/authStore";
import { useToastStore } from "../stores/toastStore";

/**
 * Sign out on the server, then clear the signed-in state here.
 *
 * Used by the Account page and the top bar's account menu. The page is cleared only once
 * the server says the session is gone: clearing it on a failed request would look signed
 * out while the session stays valid, and a reload would sign straight back in. A failure
 * is reported in a toast.
 *
 * @param navigate - The app router's navigate; the app goes back to "/" first, so signing
 *   in again lands on the dashboard rather than the page the user signed out from.
 * @returns Whether the user is now signed out.
 */
export async function signOut(navigate: (path: string) => void): Promise<boolean> {
  try {
    const { error } = await api.api.auth.logout.post();
    if (error) throw new Error((error.value as { error?: string })?.error ?? `HTTP ${error.status}`);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    useToastStore.getState().push(`Sign out failed: ${message}. You are still signed in.`, "error");
    return false;
  }
  navigate("/");
  useAuthStore.getState().logout();
  return true;
}
