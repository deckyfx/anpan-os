import { Elysia } from "elysia";
import { staticPlugin } from "@elysiajs/static";

/**
 * React app plugin for BINARY mode.
 * Serves pre-built assets from dist/ folder alongside the binary.
 */

const index = async () => Bun.file("./dist/public/index.html");

export const appPluginBinary = new Elysia()
  .use(
    staticPlugin({
      assets: "./dist",
      prefix: "/",
      alwaysStatic: true,
    }),
  )
  .get("/*", index);
