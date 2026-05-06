import { useState, useEffect } from "react";

/** Returns the current path and a navigate function that uses history.pushState. */
export function useRouter() {
  const [path, setPath] = useState(window.location.pathname);

  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const navigate = (to: string) => {
    history.pushState(null, "", to);
    setPath(to);
  };

  return { path, navigate };
}
