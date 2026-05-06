import { Elysia } from "elysia";
import index from "../public/index.html";

/**
 * React app plugin for DEVELOPMENT mode.
 * Serves directly from src/public with HMR support via Bun's bundler.
 */
export const appPlugin = new Elysia()
  .get("/", index)
  .get("/*", index);
