export interface DockerPort {
  PublicPort?: number;
  PrivatePort?: number;
  Type?: string;
}

export interface DockerService {
  id: string;
  service: string;
  image: string;
  state: string;
  ports: DockerPort[];
}

export interface StackMeta {
  id: string;
  title: string | null;
  icon: string | null;
  tagline: string | null;
  portMap: string | null;
  scheme: string | null;
  indexPath: string | null;
  mainService: string | null;
  address: string | null;
  note: string | null;
  managed: boolean | null;
  orderNo: number | null;
}

export type ComposeOrigin = "managed" | "casaos" | null;

export interface Stack {
  name: string;
  services: DockerService[];
  state: "running" | "partial" | "stopped";
  icon?: string;
  meta: StackMeta | null;
  /** Where the compose file that started this stack was found. */
  origin: ComposeOrigin;
}

export interface DiskMount {
  device: string;
  mount: string;
  used: number;
  total: number;
}

export interface SystemStats {
  cpu: number;
  ramUsed: number;
  ramTotal: number;
  disks: DiskMount[];
}

export interface ContainerDetail {
  Id: string;
  Name: string;
  State: {
    Status: string;
    Running: boolean;
    StartedAt: string;
    FinishedAt: string;
    ExitCode: number;
  };
  Config: {
    Image: string;
    Hostname: string;
    Env: string[] | null;
    Labels: Record<string, string> | null;
  };
  HostConfig: {
    RestartPolicy: { Name: string; MaximumRetryCount: number };
    NetworkMode: string;
    Binds: string[] | null;
  };
  Mounts: Array<{
    Type: string;
    Source: string;
    Destination: string;
    Mode: string;
    RW: boolean;
  }>;
  NetworkSettings: {
    Networks: Record<string, { IPAddress: string; Gateway: string }>;
    Ports: Record<string, Array<{ HostIp: string; HostPort: string }> | null>;
  };
}

export type StackAction =
  | "start"
  | "stop"
  | "restart"
  | "logs"
  | "note"
  | "detail"
  | "containers"
  | "download-compose"
  | "casaos-import"
  | "delete";

export type SortMode = "custom" | "name";
