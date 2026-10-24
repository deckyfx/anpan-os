import { test, expect, describe } from "bun:test";
import { EDGE, GAP, placeMenu } from "../src/public/app/lib/menu-placement";

/**
 * Where a tile's ⋮ menu opens. The menu is wider than the narrowest tile, so right-aligned
 * inside the tile it started left of the grid in the first column and was cut off there.
 */

const viewport = { width: 1280, height: 800 };
const menu = { width: 240, height: 300 };
/** A ⋮ button: 24 px square with its right edge at `right` and its top at `top`. */
const button = (right: number, top: number) => ({ top, right, bottom: top + 24 });

describe("placeMenu", () => {
  test("lines up with the button's right edge and opens below it", () => {
    expect(placeMenu(button(900, 100), menu, viewport)).toEqual({ left: 660, top: 124 + GAP });
  });

  test("a button nearer the left edge than the menu is wide pushes the menu back on screen", () => {
    // A 160 px tile at x = 0: right-aligned, the 240 px menu would start at x = -80.
    expect(placeMenu(button(160, 100), menu, viewport).left).toBe(EDGE);
  });

  test("never runs off the right edge", () => {
    expect(placeMenu(button(1300, 100), menu, viewport).left).toBe(viewport.width - menu.width - EDGE);
  });

  test("opens above the button when there is no room below", () => {
    expect(placeMenu(button(900, 700), menu, viewport).top).toBe(700 - GAP - menu.height);
  });

  test("with room neither below nor above, stays on screen as low as it can", () => {
    const tall = { width: 240, height: 600 };
    expect(placeMenu(button(900, 400), tall, viewport).top).toBe(viewport.height - tall.height - EDGE);
  });

  test("a menu taller than the window starts at the top edge, not above it", () => {
    expect(placeMenu(button(900, 400), { width: 240, height: 2000 }, viewport).top).toBe(EDGE);
  });
});
