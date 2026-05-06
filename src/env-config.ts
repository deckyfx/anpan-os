/**
 * Bootstrap environment configuration — only what's needed before config.toml is loaded.
 * All runtime settings (port, TLS, database) live in RUNTIME_CONFIG_DIR/config.toml.
 */
class EnvConfig {
  private static instance: EnvConfig;

  private constructor() {}

  static getInstance(): EnvConfig {
    if (!EnvConfig.instance) {
      EnvConfig.instance = new EnvConfig();
    }
    return EnvConfig.instance;
  }

  get APP_NAME(): string {
    return Bun.env.APP_NAME ?? "anpan-os";
  }

  /** Set at build time via define. Use process.env to catch build-time defines. */
  get RUN_MODE(): string {
    return process.env.RUN_MODE ?? "";
  }

  get IS_BINARY_MODE(): boolean {
    return this.RUN_MODE === "binary";
  }

  /**
   * Runtime config directory — only bootstrap env var.
   * Defaults to $HOME/.anpanos if not set.
   */
  get RUNTIME_CONFIG_DIR(): string {
    return Bun.env.RUNTIME_CONFIG_DIR ?? `${Bun.env.HOME ?? "~"}/.anpanos`;
  }
}

export const envConfig = EnvConfig.getInstance();

console.log("🔧 Run mode:", envConfig.RUN_MODE || "source");
