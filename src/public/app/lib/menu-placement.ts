/** Space kept between a menu and the edge of the window. */
export const EDGE = 8;
/** Space between a menu and the button that opened it. */
export const GAP = 4;

/** The parts of a DOMRect placement needs, so it can be tested without a DOM. */
export interface AnchorRect { top: number; right: number; bottom: number; }
export interface Size { width: number; height: number; }

/**
 * Where to put a dropdown menu opened from `anchor`, in viewport coordinates.
 *
 * The menu's right edge lines up with the anchor's, then the menu is pushed back inside the
 * window — a menu wider than a tile in the leftmost column would otherwise start left of the
 * window, or under whatever sits there. It opens below the anchor when it fits, above when
 * only that fits, and otherwise as low as it can while its top stays on screen.
 */
export function placeMenu(anchor: AnchorRect, menu: Size, viewport: Size): { left: number; top: number } {
  const left = Math.max(EDGE, Math.min(anchor.right - menu.width, viewport.width - menu.width - EDGE));

  const below = anchor.bottom + GAP;
  const above = anchor.top - GAP - menu.height;
  let top: number;
  if (below + menu.height <= viewport.height - EDGE) top = below;
  else if (above >= EDGE) top = above;
  else top = Math.max(EDGE, viewport.height - menu.height - EDGE);

  return { left, top };
}
