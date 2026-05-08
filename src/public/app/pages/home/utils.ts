import type { Stack } from "./types";

export function toGB(bytes: number): string {
  return (bytes / 1_073_741_824).toFixed(1) + "G";
}

export function buildLaunchUrl(stack: Stack): string | null {
  const meta    = stack.meta;
  const address = meta?.address?.trim() || null;
  const port    = meta?.portMap?.trim() || null;
  // Need at least an address or port to build a URL
  if (!address && !port) return null;
  const scheme   = meta?.scheme?.trim() || "http";
  const host     = address ?? (typeof window !== "undefined" ? window.location.hostname : "localhost");
  const portPart = port ? `:${port}` : "";
  const index    = meta?.indexPath ?? "/";
  return `${scheme}://${host}${portPart}${index}`;
}

export const stackStateColor: Record<Stack["state"], string> = {
  running: "bg-green-400",
  partial: "bg-yellow-400",
  stopped: "bg-red-500",
};
