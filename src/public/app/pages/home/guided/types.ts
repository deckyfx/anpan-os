export interface ServiceForm {
  imageName:    string;
  imageTag:     string;
  restart:      "no" | "always" | "on-failure" | "unless-stopped";
  containerName: string;
  ports:        Array<{ host: string; container: string; protocol: "tcp" | "udp" }>;
  environment:  Array<{ key: string; value: string | null }>;
  volumes:      Array<{ host: string; container: string; mode: "" | "ro" | "rw" }>;
  networks:     string[];
  dependsOn:    string[];
  privileged:   boolean;
  memLimitMb:   number;
  cpuLimit:     number;
  command:      string;
  entrypoint:   string;
  healthcheckTest:     string;
  healthcheckInterval: string;
  healthcheckTimeout:  string;
  healthcheckRetries:  number;

  // Extended service config
  networkMode:  string;
  labels:       Array<{ key: string; value: string }>;
  capAdd:       string[];
  capDrop:      string[];
  devices:      string[];
  extraHosts:   string[];
  dns:          string[];
  logging:      { driver: string; options: Array<{ key: string; value: string }> };
  stdinOpen:    boolean;
  tty:          boolean;
  user:         string;
  workingDir:   string;
}

export type OpenMode = "new-page" | "here" | "contained";

export interface AppConfigState {
  title:     string;
  tagline:   string;
  icon:      string;
  scheme:    string;
  portMap:   string;
  indexPath: string;
  address:   string;
  note:      string;
  openMode:  OpenMode;
}

export interface ComposeDocument {
  name?:     string;
  version?:  string;
  services:  Record<string, unknown>;
  networks?: Record<string, unknown>;
  volumes?:  Record<string, unknown>;
}

// ── Stack-level named networks / volumes ──────────────────────────────────────

export interface NamedNetwork {
  name:       string;
  driver:     string;
  external:   boolean;
  attachable: boolean;
}

export interface NamedVolume {
  name:     string;
  driver:   string;
  external: boolean;
  driverOpts: Array<{ key: string; value: string }>;
}

export interface StackConfig {
  name:     string;
  networks: NamedNetwork[];
  volumes:  NamedVolume[];
}
