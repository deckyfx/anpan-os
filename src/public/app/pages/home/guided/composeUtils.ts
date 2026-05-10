import { parse, stringify } from "yaml";
import type { ComposeDocument, ServiceForm, StackConfig, NamedNetwork, NamedVolume } from "./types";

export function parseComposeDoc(yamlStr: string): ComposeDocument {
  const doc = parse(yamlStr) as Record<string, unknown>;
  if (!doc || typeof doc !== "object") throw new Error("Invalid YAML: expected an object");
  if (!doc.services || typeof doc.services !== "object") throw new Error("Invalid compose file: missing 'services' key");
  return doc as unknown as ComposeDocument;
}

export function serializeComposeDoc(doc: ComposeDocument): string {
  return stringify(doc, { lineWidth: 0 });
}

// ─── Shared key=value parser (env, labels) ───────────────────────────────────

function parseKeyValueEntries(raw: unknown): Array<{ key: string; value: string }> {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return (raw as string[]).map(item => {
      const eq = String(item).indexOf("=");
      return eq >= 0
        ? { key: String(item).slice(0, eq), value: String(item).slice(eq + 1) }
        : { key: String(item), value: "" };
    });
  }
  if (typeof raw === "object") {
    return Object.entries(raw as Record<string, unknown>).map(([key, value]) => ({
      key,
      value: value == null ? "" : String(value),
    }));
  }
  return [];
}

// Env uses null for bare keys ("FOO" = inherit from host vs "FOO=" = explicit empty)
function parseEnvEntries(raw: unknown): Array<{ key: string; value: string | null }> {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return (raw as string[]).map(item => {
      const eq = String(item).indexOf("=");
      return eq >= 0
        ? { key: String(item).slice(0, eq), value: String(item).slice(eq + 1) }
        : { key: String(item), value: null };
    });
  }
  if (typeof raw === "object") {
    return Object.entries(raw as Record<string, unknown>).map(([key, value]) => ({
      key,
      value: value == null ? null : String(value),
    }));
  }
  return [];
}

const parseLabels = parseKeyValueEntries;

// ─── Parse ports ──────────────────────────────────────────────────────────────

function parsePorts(raw: unknown): Array<{ host: string; container: string; protocol: "tcp" | "udp" }> {
  if (!raw || !Array.isArray(raw)) return [];
  return (raw as unknown[]).map(item => {
    if (typeof item === "string") {
      const protoSplit = item.split("/");
      const protocol = (protoSplit[1] === "udp" ? "udp" : "tcp") as "tcp" | "udp";
      const mapping = protoSplit[0]!;
      const colonIdx = mapping.lastIndexOf(":");
      if (colonIdx >= 0) {
        return { host: mapping.slice(0, colonIdx), container: mapping.slice(colonIdx + 1), protocol };
      }
      return { host: "", container: mapping, protocol };
    }
    if (typeof item === "object" && item !== null) {
      const o = item as Record<string, unknown>;
      return {
        host:      String(o.published ?? o.host ?? ""),
        container: String(o.target ?? o.container ?? ""),
        protocol:  o.protocol === "udp" ? "udp" : "tcp",
      };
    }
    return { host: "", container: String(item), protocol: "tcp" };
  });
}

// ─── Parse volumes ────────────────────────────────────────────────────────────

function parseVolumes(raw: unknown): Array<{ host: string; container: string; mode: "" | "ro" | "rw" }> {
  if (!raw || !Array.isArray(raw)) return [];
  return (raw as unknown[]).map(item => {
    if (typeof item === "string") {
      const parts = item.split(":");
      const host      = parts[0] ?? "";
      const container = parts[1] ?? "";
      const modeStr   = parts[2] ?? "";
      const mode      = modeStr === "ro" ? "ro" : modeStr === "rw" ? "rw" : "" as "" | "ro" | "rw";
      return { host, container, mode };
    }
    if (typeof item === "object" && item !== null) {
      const o = item as Record<string, unknown>;
      const modeStr = String(o.mode ?? (o.read_only ? "ro" : ""));
      const mode    = modeStr === "ro" ? "ro" : modeStr === "rw" ? "rw" : "" as "" | "ro" | "rw";
      return { host: String(o.source ?? ""), container: String(o.target ?? ""), mode };
    }
    return { host: "", container: String(item), mode: "" };
  });
}

// ─── Parse memory limit ───────────────────────────────────────────────────────

function parseMemStr(raw: string): number {
  const s = raw.trim().toLowerCase();
  const n = parseFloat(s);
  if (isNaN(n)) return 0;
  if (s.endsWith("gb") || s.endsWith("g")) return Math.round(n * 1024);
  if (s.endsWith("mb") || s.endsWith("m")) return Math.round(n);
  if (s.endsWith("kb") || s.endsWith("k")) return Math.round(n / 1024);
  // bare bytes
  return Math.round(n / (1024 * 1024));
}

function parseMemMb(svc: Record<string, unknown>): number {
  if (svc.mem_limit) {
    const v = parseMemStr(String(svc.mem_limit));
    if (v > 0) return v;
  }
  const deploy = svc.deploy as Record<string, unknown> | undefined;
  const limits = deploy?.resources as Record<string, unknown> | undefined;
  const memory = (limits?.limits as Record<string, unknown> | undefined)?.memory;
  if (memory) {
    const v = parseMemStr(String(memory));
    if (v > 0) return v;
  }
  return 0;
}

function parseCpuLimit(svc: Record<string, unknown>): number {
  if (svc.cpus !== undefined) {
    const parsed = parseFloat(String(svc.cpus));
    return isNaN(parsed) ? 0 : parsed;
  }
  const deploy = svc.deploy as Record<string, unknown> | undefined;
  const limits = deploy?.resources as Record<string, unknown> | undefined;
  const cpus   = (limits?.limits as Record<string, unknown> | undefined)?.cpus;
  if (cpus !== undefined) {
    const parsed = parseFloat(String(cpus));
    return isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

// ─── parseService ─────────────────────────────────────────────────────────────

export function parseService(svc: unknown): ServiceForm {
  const s = (svc && typeof svc === "object" ? svc : {}) as Record<string, unknown>;

  const image = String(s.image ?? "");
  let imageName: string;
  let imageTag: string;
  if (image.includes("@")) {
    // digest ref (e.g. repo@sha256:abc) — preserve whole ref, no tag
    imageName = image;
    imageTag  = "latest";
  } else {
    const lastSlash = image.lastIndexOf("/");
    const lastColon = image.lastIndexOf(":");
    if (lastColon > lastSlash) {
      imageName = image.slice(0, lastColon);
      imageTag  = image.slice(lastColon + 1);
    } else {
      imageName = image;
      imageTag  = "latest";
    }
  }

  const restart = (["no", "always", "on-failure", "unless-stopped"] as const).includes(s.restart as never)
    ? s.restart as ServiceForm["restart"]
    : "no";

  const networksRaw = s.networks;
  const networks: string[] = Array.isArray(networksRaw)
    ? (networksRaw as string[]).map(String)
    : typeof networksRaw === "object" && networksRaw !== null
      ? Object.keys(networksRaw as object)
      : [];

  const dependsOnRaw = s.depends_on;
  const dependsOn: string[] = Array.isArray(dependsOnRaw)
    ? (dependsOnRaw as string[]).map(String)
    : typeof dependsOnRaw === "object" && dependsOnRaw !== null
      ? Object.keys(dependsOnRaw as object)
      : [];

  const hc = (s.healthcheck as Record<string, unknown> | undefined) ?? {};
  const hcTest = Array.isArray(hc.test)
    ? (hc.test as string[]).filter((_, i) => i > 0).join(" ")
    : String(hc.test ?? "");

  // Logging
  const loggingRaw = s.logging as Record<string, unknown> | undefined;
  const loggingDriver = String(loggingRaw?.driver ?? "");
  const loggingOptsRaw = loggingRaw?.options;
  const loggingOptions = loggingOptsRaw && typeof loggingOptsRaw === "object" && !Array.isArray(loggingOptsRaw)
    ? Object.entries(loggingOptsRaw as Record<string, unknown>).map(([key, value]) => ({ key, value: String(value ?? "") }))
    : [];

  const parseStrArr = (raw: unknown): string[] => {
    if (!raw) return [];
    if (Array.isArray(raw)) return (raw as unknown[]).map(String);
    return [];
  };

  return {
    imageName,
    imageTag,
    restart,
    containerName: String(s.container_name ?? ""),
    ports:        parsePorts(s.ports),
    environment:  parseEnvEntries(s.environment),
    volumes:      parseVolumes(s.volumes),
    networks,
    dependsOn,
    privileged:   s.privileged === true,
    memLimitMb:   parseMemMb(s),
    cpuLimit:     parseCpuLimit(s),
    command:      Array.isArray(s.command) ? (s.command as string[]).join(" ") : String(s.command ?? ""),
    entrypoint:   Array.isArray(s.entrypoint) ? (s.entrypoint as string[]).join(" ") : String(s.entrypoint ?? ""),
    healthcheckTest:     hcTest,
    healthcheckInterval: String(hc.interval ?? ""),
    healthcheckTimeout:  String(hc.timeout ?? ""),
    healthcheckRetries:  typeof hc.retries === "number" ? hc.retries : 0,

    networkMode:  String(s.network_mode ?? ""),
    labels:       parseLabels(s.labels),
    capAdd:       parseStrArr(s.cap_add),
    capDrop:      parseStrArr(s.cap_drop),
    devices:      parseStrArr(s.devices),
    extraHosts:   parseStrArr(s.extra_hosts),
    dns:          parseStrArr(s.dns),
    logging:      { driver: loggingDriver, options: loggingOptions },
    stdinOpen:    s.stdin_open === true,
    tty:          s.tty === true,
    user:         String(s.user ?? ""),
    workingDir:   String(s.working_dir ?? ""),
  };
}

// ─── serializeService ─────────────────────────────────────────────────────────

export function serializeService(form: ServiceForm): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  const image = form.imageTag && form.imageTag !== "latest"
    ? `${form.imageName}:${form.imageTag}`
    : form.imageName;
  if (image) out.image = image;

  if (form.restart && form.restart !== "no") out.restart = form.restart;
  if (form.containerName) out.container_name = form.containerName;
  if (form.networkMode)   out.network_mode   = form.networkMode;
  if (form.user)          out.user           = form.user;
  if (form.workingDir)    out.working_dir    = form.workingDir;
  if (form.stdinOpen)     out.stdin_open     = true;
  if (form.tty)           out.tty            = true;
  if (form.privileged)    out.privileged     = true;

  if (form.ports.length > 0) {
    out.ports = form.ports.map(({ host, container, protocol }) => {
      const base = host ? `${host}:${container}` : container;
      return protocol === "udp" ? `${base}/udp` : base;
    });
  }

  if (form.environment.length > 0) {
    out.environment = form.environment.map(({ key, value }) =>
      value === null ? key : `${key}=${value}`
    );
  }

  if (form.labels.length > 0) {
    out.labels = form.labels.map(({ key, value }) =>
      value ? `${key}=${value}` : key
    );
  }

  if (form.volumes.length > 0) {
    out.volumes = form.volumes.map(({ host, container, mode }) => {
      let v = host ? `${host}:${container}` : container;
      if (mode) v += `:${mode}`;
      return v;
    });
  }

  if (form.networks.length > 0) out.networks = form.networks;
  if (form.dependsOn.length > 0) out.depends_on = form.dependsOn;

  if (form.capAdd.length > 0)     out.cap_add     = form.capAdd;
  if (form.capDrop.length > 0)    out.cap_drop    = form.capDrop;
  if (form.devices.length > 0)    out.devices     = form.devices;
  if (form.extraHosts.length > 0) out.extra_hosts = form.extraHosts;
  if (form.dns.length > 0)        out.dns         = form.dns;

  if (form.logging.driver || form.logging.options.length > 0) {
    const loggingOut: Record<string, unknown> = {};
    if (form.logging.driver) loggingOut.driver = form.logging.driver;
    if (form.logging.options.length > 0) {
      loggingOut.options = Object.fromEntries(
        form.logging.options.map(({ key, value }) => [key, value])
      );
    }
    out.logging = loggingOut;
  }

  // Resource limits (v3 format)
  if (form.memLimitMb > 0 || form.cpuLimit > 0) {
    const limits: Record<string, unknown> = {};
    if (form.memLimitMb > 0) limits.memory = `${form.memLimitMb}m`;
    if (form.cpuLimit > 0) limits.cpus = String(form.cpuLimit);
    out.deploy = { resources: { limits } };
  }

  if (form.command)    out.command    = form.command;
  if (form.entrypoint) out.entrypoint = form.entrypoint;

  if (form.healthcheckTest || form.healthcheckInterval || form.healthcheckTimeout || form.healthcheckRetries > 0) {
    const hc: Record<string, unknown> = {};
    if (form.healthcheckTest)     hc.test     = ["CMD-SHELL", form.healthcheckTest];
    if (form.healthcheckInterval) hc.interval = form.healthcheckInterval;
    if (form.healthcheckTimeout)  hc.timeout  = form.healthcheckTimeout;
    if (form.healthcheckRetries > 0) hc.retries = form.healthcheckRetries;
    out.healthcheck = hc;
  }

  return out;
}

// ─── Stack-level networks/volumes parse/serialize ─────────────────────────────

export function parseStackConfig(doc: ComposeDocument): import("./types").StackConfig {
  const networks: NamedNetwork[] = [];
  const volumes:  NamedVolume[]  = [];

  if (doc.networks && typeof doc.networks === "object") {
    for (const [name, raw] of Object.entries(doc.networks as Record<string, unknown>)) {
      const n = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
      networks.push({
        name,
        driver:     String(n.driver ?? ""),
        external:   n.external === true || (typeof n.external === "object" && n.external !== null),
        attachable: n.attachable === true,
      });
    }
  }

  if (doc.volumes && typeof doc.volumes === "object") {
    for (const [name, raw] of Object.entries(doc.volumes as Record<string, unknown>)) {
      const v = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
      const driverOptsRaw = v.driver_opts;
      const driverOpts = driverOptsRaw && typeof driverOptsRaw === "object" && !Array.isArray(driverOptsRaw)
        ? Object.entries(driverOptsRaw as Record<string, unknown>).map(([key, value]) => ({ key, value: String(value ?? "") }))
        : [];
      volumes.push({
        name,
        driver:     String(v.driver ?? ""),
        external:   v.external === true || (typeof v.external === "object" && v.external !== null),
        driverOpts,
      });
    }
  }

  return { name: String((doc as unknown as Record<string, unknown>).name ?? ""), networks, volumes };
}

export function serializeStackConfig(cfg: import("./types").StackConfig, doc: ComposeDocument): ComposeDocument {
  const networks: Record<string, unknown> = {};
  for (const n of cfg.networks) {
    if (n.external) {
      networks[n.name] = { external: true };
    } else {
      const entry: Record<string, unknown> = {};
      if (n.driver)     entry.driver     = n.driver;
      if (n.attachable) entry.attachable = true;
      networks[n.name] = Object.keys(entry).length > 0 ? entry : null;
    }
  }

  const volumes: Record<string, unknown> = {};
  for (const v of cfg.volumes) {
    if (v.external) {
      volumes[v.name] = { external: true };
    } else {
      const entry: Record<string, unknown> = {};
      if (v.driver) entry.driver = v.driver;
      if (v.driverOpts.length > 0) {
        entry.driver_opts = Object.fromEntries(v.driverOpts.map(({ key, value }) => [key, value]));
      }
      volumes[v.name] = Object.keys(entry).length > 0 ? entry : null;
    }
  }

  // Build result with name first so it appears at the top of the YAML
  const result: Record<string, unknown> = {};
  if (cfg.name) result.name = cfg.name;
  const { name: _n, networks: _nets, volumes: _vols, ...rest } = doc as unknown as Record<string, unknown>;
  Object.assign(result, rest);
  if (cfg.networks.length > 0) result.networks = networks;
  if (cfg.volumes.length  > 0) result.volumes  = volumes;
  return result as unknown as ComposeDocument;
}
