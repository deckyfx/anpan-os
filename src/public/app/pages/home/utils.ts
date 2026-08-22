import type { Stack } from "./types";

export function toGB(bytes: number): string {
  return (bytes / 1_073_741_824).toFixed(1) + "G";
}

/**
 * Hostname suffixes that denote a LAN / mDNS name rather than a public DNS name.
 * Hosts under these suffixes are reached directly on the container's published
 * port, so the port must stay in the launch URL.
 */
const LOCAL_TLDS = new Set([
  "local", "lan", "home", "internal", "intranet", "private",
  "corp", "localdomain", "test", "localhost",
]);

/** Default port for a scheme — never worth spelling out in a URL. */
const DEFAULT_PORTS: Record<string, string> = { http: "80", https: "443" };

/** True for IPv4 / bracketed-IPv6 literals (`192.168.1.10`, `[::1]`). */
function isIpLiteral(host: string): boolean {
  if (host.startsWith("[")) return true;
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

/**
 * True when a host looks like a public DNS name that a reverse proxy fronts —
 * dotted, not an IP literal, and not under a LAN/mDNS suffix.
 * Those hosts answer on the scheme's default port, so the stack's published
 * port must NOT be appended.
 */
function isProxiedDomain(host: string): boolean {
  if (isIpLiteral(host)) return false;
  const labels = host.split(".");
  if (labels.length < 2) return false;                       // bare LAN name: "nas"
  return !LOCAL_TLDS.has(labels[labels.length - 1]!.toLowerCase());
}

/** Split `host`, `host:port`, `[::1]:port` or a bare IPv6 into its parts. */
function splitAuthority(raw: string): { host: string; port: string | null } {
  if (raw.startsWith("[")) {
    const end = raw.indexOf("]");
    if (end > 0) {
      const rest = raw.slice(end + 1).match(/^:(\d+)$/);
      return { host: raw.slice(0, end + 1), port: rest?.[1] ?? null };
    }
  }
  // More than one colon and no brackets → bare IPv6 literal, never host:port
  if ((raw.match(/:/g)?.length ?? 0) > 1) return { host: `[${raw}]`, port: null };
  const m = raw.match(/^(.+):(\d+)$/);
  return m ? { host: m[1]!, port: m[2]! } : { host: raw, port: null };
}

/** Keep the first numeric group of a port field (`8080`, `8080:80`, `8080/tcp`). */
function normalizePort(raw: string | null): string | null {
  if (!raw) return null;
  // Drop an optional bind address first: in "127.0.0.1:8080:80" the first number is part
  // of the IP, so matching the first digits anywhere would yield 127.
  const stripped = raw.replace(/^(\[[^\]]+\]|\d{1,3}(?:\.\d{1,3}){3}):/, "");
  // The host-side port is the leading segment; a range like "8080-8090:80" starts at 8080.
  return stripped.split(":")[0]?.match(/\d+/)?.[0] ?? null;
}

export interface LaunchInput {
  scheme?:    string | null;
  /** Host, `host:port`, or a full URL. Blank = the host serving this page. */
  address?:   string | null;
  /** Published port from the stack metadata / compose port map. */
  port?:      string | null;
  indexPath?: string | null;
  /** Host to fall back to when `address` is blank. */
  fallbackHost?: string;
}

/**
 * Resolve the URL used to open a stack's web UI.
 *
 * The published port is only appended when the target is actually reached on
 * it. An address pointing at a public domain name is assumed to sit behind a
 * reverse proxy and is opened as-is; an explicit port typed into the address
 * always wins, which is the escape hatch for a domain served on a custom port.
 *
 * ```
 * app.example.com  + 8080 -> https://app.example.com/
 * app.example.com:8080    -> https://app.example.com:8080/
 * nas.local        + 8080 -> http://nas.local:8080/
 * 192.168.1.10     + 8080 -> http://192.168.1.10:8080/
 * (blank)          + 8080 -> http://<current host>:8080/
 * ```
 *
 * @returns the absolute URL, or `null` when there is nothing to open.
 */
export function resolveLaunchUrl(input: LaunchInput): string | null {
  const rawAddress = input.address?.trim() || "";
  const metaPort   = normalizePort(input.port?.trim() || null);
  // Need at least an address or a port to point at something
  if (!rawAddress && !metaPort) return null;

  let scheme      = input.scheme?.trim() || "http";
  let path        = input.indexPath?.trim() || "/";
  let host: string;
  let explicitPort: string | null = null;
  /** A full URL in the address field describes the target completely. */
  let selfContained = false;

  if (rawAddress.includes("://")) {
    // Full URL in the address field — it describes the target completely
    let url: URL;
    try { url = new URL(rawAddress); } catch { return null; }
    selfContained = true;
    scheme       = url.protocol.replace(/:$/, "");
    host         = url.hostname;
    explicitPort = url.port || null;
    // Query and fragment are part of where the user is pointing — dropping "?tab=logs"
    // or "#panel" lands them somewhere else in the app.
    if (url.pathname !== "/" || url.search || url.hash) path = url.pathname + url.search + url.hash;
  } else if (rawAddress) {
    const parts  = splitAuthority(rawAddress);
    host         = parts.host;
    explicitPort = parts.port;
  } else {
    host = input.fallbackHost
        ?? (typeof window !== "undefined" ? window.location.hostname : "localhost");
  }

  // An address with its own port always wins; otherwise fall back to the
  // published port, but only when the host is not a proxied domain.
  const autoPort = selfContained || isProxiedDomain(host) ? null : metaPort;
  let port = explicitPort ?? autoPort;
  if (port === DEFAULT_PORTS[scheme]) port = null;

  if (!path.startsWith("/")) path = `/${path}`;
  return `${scheme}://${host}${port ? `:${port}` : ""}${path}`;
}

export function buildLaunchUrl(stack: Stack): string | null {
  return resolveLaunchUrl({
    scheme:    stack.meta?.scheme,
    address:   stack.meta?.address,
    port:      stack.meta?.portMap,
    indexPath: stack.meta?.indexPath,
  });
}

/**
 * Short label for a launch link — `:8080` when a port is part of the URL,
 * otherwise the hostname, so proxied domains no longer advertise a stale port.
 */
export function launchLabel(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.port ? `:${parsed.port}` : parsed.hostname;
  } catch {
    return url;
  }
}

export const stackStateColor: Record<Stack["state"], string> = {
  running: "bg-green-400",
  partial: "bg-yellow-400",
  stopped: "bg-red-500",
};
