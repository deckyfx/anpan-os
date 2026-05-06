import { treaty } from "@elysiajs/eden";
import type { App } from "../../../app";

/**
 * Type-safe API client using Eden Treaty.
 * Uses window.location.origin to avoid hardcoding the server URL.
 */
export const api = treaty<App>(
  typeof window !== "undefined"
    ? window.location.origin
    : "https://localhost:3001",
);
