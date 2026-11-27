import { join, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { envConfig } from "./env-config";
import { DEFAULT_SMB_CONF } from "./lib/platform";

const CONFIG_FILE = "config.toml";

const BLANK_CONFIG = `# anpan-os configuration
# Auto-generated on first run. Edit as needed.

[server]
port = 3000
bind = "local"   # "local" = 127.0.0.1 only | "public" = 0.0.0.0 (all interfaces)
# tls_cert = "/etc/anpan-os/cert.pem"
# tls_key  = "/etc/anpan-os/key.pem"
# TLS is optional — if cert/key are unset or files are missing, server runs on HTTP.
# allowed_origins = []   # extra origins allowed to change things — for a proxy that rewrites Host

[auth]
# username = "admin"
# password_hash = ""   # bcrypt hash — set via the setup endpoint
# jwt_secret   = ""   # randomly generated on first run
# Allowed origins for passkey authentication.
# Add every URL you use to access anpan-os (protocol + hostname + optional port).
# Leave empty to accept any origin (suitable for local / private networks).
passkey_allowed_origins = []
# session_same_site = "strict"   # "lax" allows multi-hostname LAN access (default: strict)
# disable_login_method = []      # "form" disables password login/setup; "passkey" disables passkey auth/registration

[compose]
# folder = "..."   # defaults to <runtime dir>/composes (/var/lib/anpan-os/composes on Linux)

[apps]
# data_root = "/DATA/AppData"   # where each app keeps its data, one folder per app
#                               # defaults to <runtime dir>/appdata
# puid = 1000                   # $PUID / $PGID given to apps that ask for them (CasaOS-style)
# pgid = 1000
# tz = "Asia/Jakarta"           # $TZ given to apps; defaults to this machine's time zone

[files]
root = "/"   # root path the file manager is allowed to browse
# metadata_lookup = false   # allow track lookup at iTunes / MusicBrainz (sends track and album names off-box)

[samba]
# smb_conf = "..."   # system smb.conf (anpan-os adds one include line here)
#                    # defaults: /etc/samba/smb.conf (Linux), <brew prefix>/etc/smb.conf (macOS)
`;

interface ServerConfig {
  port?: number;
  bind?: "local" | "public";
  tls_cert?: string;
  tls_key?: string;
  /**
   * Origins, besides the one a request is addressed to, whose pages may change things —
   * e.g. "https://anpan.example.com" behind a reverse proxy that rewrites the Host header.
   */
  allowed_origins?: string[];
}

interface AuthConfig {
  username?: string;
  password_hash?: string;
  jwt_secret?: string;
  passkey_allowed_origins?: string[];
  /** SameSite policy for the session cookie. Default "strict". Use "lax" for LAN / multi-hostname access. */
  session_same_site?: "strict" | "lax" | "none";
  /** Login methods that are turned off. "form" disables password login/setup; "passkey" disables passkey auth/registration. */
  disable_login_method?: ("passkey" | "form")[];
}

interface ComposeConfig {
  folder?: string;
}

/** `[apps]`: values the app platform gives to installed apps. */
interface AppsConfig {
  /** Folder holding one data folder per app. CasaOS uses /DATA/AppData. */
  data_root?: string;
  /** User and group id handed to apps as $PUID and $PGID. */
  puid?: number;
  pgid?: number;
  /** Time zone handed to apps as $TZ. */
  tz?: string;
}

interface FilesConfig {
  root?: string;
  /**
   * Allow looking up track metadata at iTunes and MusicBrainz.
   *
   * Off by default and opt-in: anpan-os otherwise talks only to the local Docker socket
   * and to registries the user has already chosen to pull from. Sending track and album
   * names — which describe a private library — to third parties should be a decision, not
   * a default.
   */
  metadata_lookup?: boolean;
}

interface SambaConfig {
  /** Path to the system smb.conf (read to detect/add our include line). */
  smb_conf?: string;
}

interface AppConfig {
  server:  ServerConfig;
  auth:    AuthConfig;
  compose: ComposeConfig;
  apps:    AppsConfig;
  files:   FilesConfig;
  samba:   SambaConfig;
}

/** Reads RUNTIME_CONFIG_DIR/config.toml. Creates a template on first run. */
class Config {
  private static instance: Config;
  private data: AppConfig = { server: {}, auth: {}, compose: {}, apps: {}, files: {}, samba: {} };
  private configPath: string;
  private _tlsEnabled = false;

  private constructor() {
    this.configPath = join(envConfig.RUNTIME_CONFIG_DIR, CONFIG_FILE);
  }

  /** Returns the singleton Config instance, creating it on first call. */
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
      apps:    parsed.apps    ?? {},
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

  /** Raw auth config section from config.toml. */
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

  /**
   * Origins allowed to make state-changing requests, besides the host a request was
   * addressed to: `server.allowed_origins` plus `auth.passkey_allowed_origins`. The passkey
   * list counts because it already records the addresses anpan-os is reached at — someone
   * who listed their public hostname there for passkeys uses that hostname for everything.
   */
  get allowedOrigins(): string[] {
    return [...new Set([
      ...(this.data.server.allowed_origins ?? []),
      ...(this.data.auth.passkey_allowed_origins ?? []),
    ])];
  }

  /**
   * Login methods that are disabled. Returns an empty Set when nothing is disabled.
   * Valid values: "form" (disables password login/setup), "passkey" (disables passkey auth/registration).
   */
  get disabledLoginMethods(): Set<"passkey" | "form"> {
    const raw = this.data.auth.disable_login_method ?? [];
    const valid = new Set<"passkey" | "form">(["passkey", "form"]);
    return new Set(raw.filter((m): m is "passkey" | "form" => valid.has(m as "passkey" | "form")));
  }

  /**
   * SameSite policy for the session cookie.
   * "strict" (default) — most secure; one hostname only.
   * "lax"              — allows LAN access from multiple hostnames / IPs.
   * "none"             — requires Secure (HTTPS); cross-site usage.
   */
  get sessionSameSite(): "strict" | "lax" | "none" {
    const raw = this.data.auth.session_same_site;
    if (raw === "lax") return "lax";
    if (raw === "none") return this._tlsEnabled ? "none" : "lax";
    return "strict";
  }

  /** Compose stacks folder — defaults to RUNTIME_CONFIG_DIR/composes. */
  get composeFolder(): string {
    return this.data.compose.folder ?? join(envConfig.RUNTIME_CONFIG_DIR, "composes");
  }

  /** Folder holding one data folder per app — defaults to RUNTIME_CONFIG_DIR/appdata. */
  get appDataRoot(): string {
    return resolve(this.data.apps.data_root ?? join(envConfig.RUNTIME_CONFIG_DIR, "appdata"));
  }

  /** $PUID and $PGID for apps that ask for them. 1000 is the first regular user on most distros. */
  get appIds(): { puid: number; pgid: number } {
    const id = (v: unknown) => (Number.isInteger(v) && (v as number) >= 0 ? (v as number) : 1000);
    return { puid: id(this.data.apps.puid), pgid: id(this.data.apps.pgid) };
  }

  /** $TZ for apps: the configured zone, else this machine's. */
  get appTimeZone(): string {
    return this.data.apps.tz || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  }

  /** Root path the file manager is allowed to browse — defaults to "/". */
  get filesRoot(): string {
    return this.data.files.root ?? "/";
  }

  /** Whether online metadata lookup is permitted. Off unless explicitly enabled. */
  get metadataLookupEnabled(): boolean {
    return this.data.files.metadata_lookup === true;
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
   * Path to the system smb.conf. anpan-os adds a single `include = <sambaSharesPath>`
   * line here (requires root).
   *
   * The default is platform-dependent: /etc/samba/smb.conf on Linux, and the Homebrew
   * prefix's etc/smb.conf on macOS — /opt/homebrew on Apple Silicon, /usr/local on Intel.
   * macOS has no /etc/samba at all, so the Linux default would silently create a file
   * that no smbd ever reads.
   */
  get smbConfPath(): string {
    const raw = this.data.samba.smb_conf;
    if (!raw) return DEFAULT_SMB_CONF;
    return resolve(raw);
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
   * SQLite database file path — always RUNTIME_CONFIG_DIR/storage.db.
   */
  get databasePath(): string {
    return join(envConfig.RUNTIME_CONFIG_DIR, "storage.db");
  }

  /** Writes a blank config.toml template to disk, creating the config directory if needed. */
  private async createBlank(): Promise<void> {
    mkdirSync(envConfig.RUNTIME_CONFIG_DIR, { recursive: true });
    await Bun.write(this.configPath, BLANK_CONFIG);
    console.log(`📄 Created blank config: ${this.configPath}`);
  }
}

export const config = Config.getInstance();
