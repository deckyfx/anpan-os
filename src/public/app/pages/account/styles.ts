/** Class names shared by the Account page's cards, so their controls look and size alike. */

/** At least 24×24 px, and 44×44 px on touch screens (WCAG 2.5.8 / 2.5.5). */
export const TARGET = "min-h-6 min-w-6 pointer-coarse:min-h-11 pointer-coarse:min-w-11";

export const INPUT =
  "w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500 pointer-coarse:min-h-11";

export const LABEL = "block text-[10px] font-semibold text-gray-500 uppercase tracking-widest mb-1.5";

const BUTTON = `inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-colors disabled:opacity-40 ${TARGET}`;

/** Secondary action: grey, bordered. */
export const QUIET_BUTTON = `${BUTTON} text-gray-300 bg-gray-800 border border-gray-700 hover:bg-gray-700 hover:text-white`;

/** Primary action: blue, filled. */
export const PRIMARY_BUTTON = `${BUTTON} bg-blue-600 hover:bg-blue-500 text-white font-semibold`;

/** The destructive half of an inline two-step confirm. */
export const DANGER_BUTTON = `${BUTTON} bg-red-500/90 hover:bg-red-500 text-white`;

/** A card on one of the Account pages. */
export const CARD = "bg-gray-900 border border-gray-800 rounded-xl p-5";
