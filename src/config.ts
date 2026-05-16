import { join, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { envConfig } from "./env-config";

const CONFIG_FILE = "config.toml";

const BLANK_CONFIG = `# anpan-os configuration
# Auto-generated on first run. Edit as needed.

[server]
port = 3000
bind = "local"   # "local" = 127.0.0.1 only | "public" = 0.0.0.0 (all interfaces)
# tls_cert = "/etc/anpan-os/cert.pem"
# tls_key  = "/etc/anpan-os/key.pem"
# TLS is optional — if cert/key are unset or files are missing, server runs on HTTP.

[auth]
# username = "admin"
# password_hash = ""   # bcrypt hash — set via the setup endpoint
# jwt_secret   = ""   # randomly generated on first run
# Allowed origins for passkey authentication.
# Add every URL you use to access anpan-os (protocol + hostname + optional port).
# Leave empty to accept any origin (suitable for local / private networks).
passkey_allowed_origins = []

[compose]
# folder = "/var/lib/anpan-os/composes"   # defaults to $HOME/.anpanos/composes

[files]
root = "/"   # root path the file manager is allowed to browse

[samba]
# smb_conf = "/etc/samba/smb.conf"   # system smb.conf (anpan-os adds one include line here)
`;

interface ServerConfig {
  port?: number;
  bind?: "local" | "public";
  tls_cert?: string;
  tls_key?: string;
}

interface AuthConfig {
  username?: string;
  password_hash?: string;
  jwt_secret?: string;
  passkey_allowed_origins?: string[];
}

interface ComposeConfig {
  folder?: string;
}

interface FilesConfig {
  root?: string;
}

interface SambaConfig {
  /** Path to the system smb.conf (read to detect/add our include line). */
  smb_conf?: string;
}

interface AppConfig {
  server:  ServerConfig;
  auth:    AuthConfig;
  compose: ComposeConfig;
  files:   FilesConfig;
  samba:   SambaConfig;
}

/** Reads RUNTIME_CONFIG_DIR/config.toml. Creates a template on first run. */
class Config {
  private static instance: Config;
  private data: AppConfig = { server: {}, auth: {}, compose: {}, files: {}, samba: {} };
  private configPath: string;
  private _tlsEnabled = false;

  private constructor() {
    this.configPath = join(envConfig.RUNTIME_CONFIG_DIR, CONFIG_FILE);
  }

  static getInstance(): Config {
    if (!Config.instance) {
      Config.instance = new Config();
    }
    return Config.instance;
  }

  /**
   * Load config from disk. Creates a template config.toml if it doesn't exist.
   * Also checks TLS file availability so tlsEnabled can be read synchronously.
   */
  async load(): Promise<void> {
    const file = Bun.file(this.configPath);

    if (!(await file.exists())) {
      await this.createBlank();
    }

    const raw = await file.text();
    const parsed = Bun.TOML.parse(raw) as Partial<AppConfig>;

    this.data = {
      server:  parsed.server  ?? {},
      auth:    parsed.auth    ?? {},
      compose: parsed.compose ?? {},
      files:   parsed.files   ?? {},
      samba:   parsed.samba   ?? {},
    };

    // Resolve TLS availability once so callers don't need async checks.
    const cert = this.data.server.tls_cert;
    const key  = this.data.server.tls_key;
    this._tlsEnabled = !!(
      cert && key &&
      (await Bun.file(cert).exists()) &&
      (await Bun.file(key).exists())
    );

    if (cert && key && !this._tlsEnabled) {
      console.warn(`⚠️  TLS cert/key configured but files not found — falling back to HTTP`);
    }
  }

  get auth(): Readonly<AuthConfig> {
    return this.data.auth;
  }

  /**
   * Origins permitted for WebAuthn/passkey operations.
   * Empty array = accept any origin (open for private networks).
   * Defaults to [] (accept any origin).
   */
  get passkeyAllowedOrigins(): string[] {
    return this.data.auth.passkey_allowed_origins ?? [];
  }

  /** Compose stacks folder — defaults to RUNTIME_CONFIG_DIR/composes. */
  get composeFolder(): string {
    return this.data.compose.folder ?? join(envConfig.RUNTIME_CONFIG_DIR, "composes");
  }

  /** Root path the file manager is allowed to browse — defaults to "/". */
  get filesRoot(): string {
    return this.data.files.root ?? "/";
  }

  /**
   * Path to our managed share list — always RUNTIME_CONFIG_DIR/samba.conf.
   * Contains only [ShareName] sections; no [global] block.
   * Writable by the app process without root.
   */
  get sambaSharesPath(): string {
    return resolve(envConfig.RUNTIME_CONFIG_DIR, "samba.conf");
  }

  /**
   * Path to the system smb.conf — defaults to /etc/samba/smb.conf.
   * anpan-os adds a single `include = <sambaSharesPath>` line here (requires root).
   */
  get smbConfPath(): string {
    return this.data.samba.smb_conf ?? "/etc/samba/smb.conf";
  }

  /** Server port — defaults to 3000. */
  get port(): number {
    return this.data.server.port ?? 3000;
  }

  /**
   * Bind address resolved from config.
   * "local"  → 127.0.0.1 (loopback only)
   * "public" → 0.0.0.0   (all interfaces)
   * Defaults to "local" if unset.
   */
  get hostname(): string {
    return (this.data.server.bind ?? "local") === "public" ? "0.0.0.0" : "127.0.0.1";
  }

  /**
   * Whether TLS is active. Determined at load() time by checking that both
   * tls_cert and tls_key are configured and their files exist on disk.
   */
  get tlsEnabled(): boolean {
    return this._tlsEnabled;
  }

  /** TLS certificate path — only meaningful when tlsEnabled is true. */
  get tlsCert(): string {
    return this.data.server.tls_cert!;
  }

  /** TLS private key path — only meaningful when tlsEnabled is true. */
  get tlsKey(): string {
    return this.data.server.tls_key!;
  }

  /**
   * SQLite database path — always RUNTIME_CONFIG_DIR/storage.db.
   * Formatted as a libsql file URL for use with @libsql/client.
   */
  get databaseUrl(): string {
    return `file:${join(envConfig.RUNTIME_CONFIG_DIR, "storage.db")}`;
  }

  private async createBlank(): Promise<void> {
    mkdirSync(envConfig.RUNTIME_CONFIG_DIR, { recursive: true });
    await Bun.write(this.configPath, BLANK_CONFIG);
    console.log(`📄 Created blank config: ${this.configPath}`);
  }
}

export const config = Config.getInstance();
