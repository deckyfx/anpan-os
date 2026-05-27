import { envConfig } from "./env-config";
import { config } from "./config";
import { MigrationManager } from "./db/migration-manager";
import { SettingsStore } from "./stores/settings-store";
import { AppRepoStore }  from "./stores/app-repo-store";
import { createApp } from "./app";
import { appPlugin } from "./plugins/routeApp";

// --- CLI: --doctor ---
// Checks that all required external tools are installed on this system.
if (Bun.argv.includes("--doctor")) {
  const { runDoctor } = await import("./cli/doctor");
  await runDoctor();
}

// --- CLI: --reset-user ---
// Wipes the users table so a new admin can be created on next start.
if (Bun.argv.includes("--reset-user")) {
  const { runResetUser } = await import("./cli/reset-user");
  await runResetUser();
}

// --- Server startup ---
await config.load();
await MigrationManager.init({ autoMigrate: true });
await AppRepoStore.seedDefaults();

const jwtSecret =
  (config.auth.jwt_secret?.trim().length ?? 0) > 0
    ? config.auth.jwt_secret!
    : await SettingsStore.getOrCreateJwtSecret();

const app = createApp(jwtSecret)
  .use(appPlugin)
  .listen({
    hostname: config.hostname,
    port: config.port,
    tls: config.tlsEnabled
      ? { cert: Bun.file(config.tlsCert), key: Bun.file(config.tlsKey) }
      : undefined,
    // Disable Bun's built-in dev-server client injection (/_bun/client).
    // That script opens a WebSocket and calls location.reload() on any file-watcher
    // event — including SQLite WAL writes in configs/ — causing dialogs to close.
    development: false,
  });

const protocol = config.tlsEnabled ? "https" : "http";
console.log(
  `anpan-os running at ${protocol}://${config.hostname}:${app.server?.port}`,
);
