import { Elysia } from "elysia";
import { authGuard } from "./authGuard";
import { bins } from "../lib/commands";

// Injected at build time via define; falls back to reading package.json from CWD in dev.
const APP_VERSION: string =
  (process.env.APP_VERSION as string | undefined) ??
  ((await Bun.file("package.json").json()) as { version?: string }).version ??
  "0.0.0";

export function systemPlugin(jwtSecret: string) {
  return new Elysia({ prefix: "/api/system" })
    .use(authGuard(jwtSecret))
    .get("/info", () => ({ version: APP_VERSION }))
    .get("/stats", async () => {
      const [cpu, ram, disk] = await Promise.all([getCpu(), getRam(), getDisk()]);
      return { cpu, ...ram, ...disk };
    });
}

/** CPU usage % — two /proc/stat samples 150 ms apart. */
async function getCpu(): Promise<number> {
  const sample = async () => {
    const text = await Bun.file("/proc/stat").text();
    const parts = text.split("\n")[0]!.trim().split(/\s+/).slice(1).map(Number);
    const idle  = (parts[3] ?? 0) + (parts[4] ?? 0); // idle + iowait
    const total = parts.reduce((a, b) => a + b, 0);
    return { idle, total };
  };

  const s1 = await sample();
  await Bun.sleep(150);
  const s2 = await sample();

  const deltaIdle  = s2.idle  - s1.idle;
  const deltaTotal = s2.total - s1.total;
  if (deltaTotal === 0) return 0;
  return Math.round((1 - deltaIdle / deltaTotal) * 100);
}

/** RAM from /proc/meminfo — returns bytes. */
async function getRam(): Promise<{ ramUsed: number; ramTotal: number }> {
  const text  = await Bun.file("/proc/meminfo").text();
  const lines = text.split("\n");
  const get   = (key: string) => {
    const line = lines.find((l) => l.startsWith(key));
    return line ? parseInt(line.split(/\s+/)[1]!, 10) * 1024 : 0;
  };
  const total = get("MemTotal:");
  const avail = get("MemAvailable:");
  return { ramUsed: total - avail, ramTotal: total };
}

/** Disk usage for / from `df -k`. Returns bytes. */
async function getDisk(): Promise<{ diskUsed: number; diskTotal: number }> {
  const result = await Bun.$`${bins.df} -k /`.quiet().nothrow();
  const parts  = result.stdout.toString().trim().split("\n")[1]?.trim().split(/\s+/) ?? [];
  const total  = parseInt(parts[1] ?? "0", 10) * 1024;
  const used   = parseInt(parts[2] ?? "0", 10) * 1024;
  return { diskUsed: used, diskTotal: total };
}
