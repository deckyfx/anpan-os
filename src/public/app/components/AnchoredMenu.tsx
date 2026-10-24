import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { EDGE, placeMenu } from "../lib/menu-placement";

interface AnchoredMenuProps {
  /** The button that opened the menu; the menu is placed against it. */
  anchor: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  /** Width and any other classes for the menu panel. */
  className?: string;
  children: React.ReactNode;
}

/**
 * A dropdown menu rendered into `document.body` and positioned against its trigger.
 *
 * Rendered inside the tile instead, it was clipped by the scrolling grid around it, so a menu
 * wider than its tile lost its left part under the sidebar. In the body, no ancestor's
 * overflow or transform can clip it. See `placeMenu` for where it goes. Clicking outside and
 * Escape close it; scrolling and resizing move it with its button.
 */
export function AnchoredMenu({ anchor, onClose, className = "", children }: AnchoredMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  // Measure before paint, so the menu never shows at the wrong place first.
  useLayoutEffect(() => {
    const place = () => {
      const a = anchor.current?.getBoundingClientRect();
      const m = menuRef.current?.getBoundingClientRect();
      if (!a || !m) return;
      setPos(placeMenu(a, m, { width: window.innerWidth, height: window.innerHeight }));
    };
    place();
    // Capture, so scrolling any container — not just the window — keeps the menu on its button.
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [anchor]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div
        ref={menuRef}
        className={`fixed z-41 overflow-y-auto bg-gray-800 border border-gray-700 rounded-xl shadow-2xl p-1 text-sm ${className}`}
        style={{
          left: pos?.left ?? 0,
          top: pos?.top ?? 0,
          maxHeight: `calc(100vh - ${EDGE * 2}px)`,
          visibility: pos ? "visible" : "hidden",
        }}
      >
        {children}
      </div>
    </>,
    document.body,
  );
}
