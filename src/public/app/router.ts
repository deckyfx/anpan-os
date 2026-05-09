import { useSyncExternalStore } from "react";

function subscribe(callback: () => void) {
  window.addEventListener("popstate", callback);
  return () => window.removeEventListener("popstate", callback);
}

function getSnapshot() {
  return window.location.pathname;
}

/** Returns the current path and a navigate function that uses history.pushState. */
export function useRouter() {
  const path = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const navigate = (to: string) => {
    history.pushState(null, "", to);
    // pushState does not fire popstate — dispatch manually so all subscribers update
    window.dispatchEvent(new PopStateEvent("popstate"));
  };

  return { path, navigate };
}
