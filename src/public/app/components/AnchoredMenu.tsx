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
 *
 * Out of the tile, the menu is no longer next to its trigger in tab order, so focus is moved
 * into it on open and handed back to the trigger on close.
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

  // Focus the first action once the menu is visible: a hidden element cannot take focus.
  const placed = pos !== null;
  useEffect(() => {
    if (placed) menuRef.current?.querySelector<HTMLElement>("button:not(:disabled)")?.focus({ preventScroll: true });
  }, [placed]);

  // Hand focus back to the trigger — unless something else took it, such as the dialog an
  // action opened. A focused element that is removed leaves focus on the body.
  useEffect(() => {
    const trigger = anchor.current;
    const menu = menuRef.current;
    return () => {
      const active = document.activeElement;
      if (!active || active === document.body || menu?.contains(active)) trigger?.focus({ preventScroll: true });
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
        // Tab past the last action would reach the page behind the backdrop with the menu still
        // open. Only a blur with a destination closes it: Safari does not focus a clicked button,
        // so clicking an action blurs to nothing, and closing then would swallow the click.
        onBlur={(e) => {
          const next = e.relatedTarget;
          if (next instanceof Node && !e.currentTarget.contains(next)) onClose();
        }}
        className={`fixed z-41 overflow-y-auto bg-gray-800 border border-gray-700 rounded-xl shadow-2xl p-1 text-sm ${className}`}
        style={{
          left: pos?.left ?? 0,
          top: pos?.top ?? 0,
          maxHeight: `calc(100vh - ${EDGE * 2}px)`,
          maxWidth: `calc(100vw - ${EDGE * 2}px)`,
          visibility: pos ? "visible" : "hidden",
        }}
      >
        {children}
      </div>
    </>,
    document.body,
  );
}
