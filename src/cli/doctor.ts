import { cpus, networkInterfaces, release as osRelease, totalmem, type as osType, userInfo } from "node:os";
import { join } from "node:path";
import { commands } from "../lib/commands";
import { envConfig } from "../env-config";
import { service } from "../lib/providers";
import { IS_LINUX, IS_MACOS, PLATFORM_LABEL, detectSamba } from "../lib/platform";

/** Purely decorative — the platform is already named beside it. */
const OS_ICON = IS_MACOS ? "🍎" : IS_LINUX ? "🐧" : "💻";

/** Version injected at build time; falls back in a source run. */
const APP_VERSION = process.env.APP_VERSION ?? "dev";

/** Who this process is, since half the checks below depend on privilege. */
function runningAs(): string {
  const uid = process.getuid?.() ?? -1;
  let name = "unknown";
  try { name = userInfo().username; } catch { /* no passwd entry */ }
  return uid === 0 ? `${name} (root)` : `${name} (uid ${uid})`;
}

interface ConfiguredServer {
  /** Absolute path to config.toml, whether or not it exists. */
  path:    string;
  exists:  boolean;
  /** A usable port, or null when the file gives none we can serve on. */
  port:    number | null;
  bind:    string | null;
  /** Why `port` is null, when the file exists. Shown verbatim. */
  problem: string | null;
}

/**
 * Read the configured port without loading the config.
 *
 * config.load() writes a template when none exists, and `--doctor` must not change the
 * machine it is reporting on — running it before installing would leave a config file
 * behind and make the next install think it had already been configured.
 */
async function readConfiguredServer(): Promise<ConfiguredServer> {
  const path = join(envConfig.RUNTIME_CONFIG_DIR, "config.toml");
  const file = Bun.file(path);
  if (!(await file.exists())) {
    return { path, exists: false, port: null, bind: null, problem: null };
  }

  // Reading and parsing are separate failures with separate fixes. exists() succeeding
  // does not mean the read will: the config is root-owned, so an unprivileged --doctor
  // can be refused it — and sharing one catch reported that as malformed TOML, sending
  // the user to inspect a file that was never the problem.
  let text: string;
  try {
    text = await file.text();
  } catch (e) {
    return { path, exists: true, port: null, bind: null, problem: `could not be read (${(e as Error).message})` };
  }

  let data: { server?: { port?: unknown; bind?: unknown } };
  try {
    data = Bun.TOML.parse(text) as typeof data;
  } catch (e) {
    return { path, exists: true, port: null, bind: null, problem: `not valid TOML (${(e as Error).message})` };
  }

  // Mirrors the default in config.ts, so the doctor agrees with what the server does.
  const raw = data.server?.port ?? 3000;

  // Nothing validates this on the way in — config.load() casts the parsed TOML and
  // config.port passes the value through — so a hand-edited `port = "8080"` or
  // `port = 70000` reaches here intact. Printing an address built from it would send
  // someone to an endpoint that cannot exist, and quietly imply the config was fine.
  const port =
    typeof raw === "number" && Number.isInteger(raw) && raw >= 1 && raw <= 65535 ? raw : null;

  const bind = data.server?.bind === "public" ? "public" : "local";

  return {
    path,
    exists:  true,
    port,
    bind,
    problem: port === null ? `port must be a whole number from 1 to 65535, found ${JSON.stringify(raw)}` : null,
  };
}

/** First non-internal IPv4 address, for a URL someone can actually open. */
function lanAddress(): string | null {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal) return a.address;
    }
  }
  return null;
}

/** Run the --doctor CLI check and exit. */
export async function runDoctor(): Promise<never> {
  const isTTY  = process.stdout.isTTY;
  const RESET  = isTTY ? "\x1b[0m"  : "";
  const BOLD   = isTTY ? "\x1b[1m"  : "";
  const DIM    = isTTY ? "\x1b[2m"  : "";
  const GREEN  = isTTY ? (Bun.color("green",  "ansi") ?? "") : "";
  const RED    = isTTY ? (Bun.color("red",    "ansi") ?? "") : "";
  const YELLOW = isTTY ? (Bun.color("yellow", "ansi") ?? "") : "";
  const CYAN   = isTTY ? (Bun.color("cyan",   "ansi") ?? "") : "";

  console.log(`\n${BOLD}🍞 anpan-os doctor${RESET}\n`);

  // ── Host ───────────────────────────────────────────────────────────────────
  //
  // Named before anything else because every line below is conditional on it: which tools
  // are applicable, which service manager is in charge, and which SMB server exists are
  // all answers to "what is this machine".
  const kernel = `${osType()} ${osRelease()}`;
  console.log(`  ${BOLD}${OS_ICON}  ${PLATFORM_LABEL}${RESET}  ${DIM}${kernel} · ${cpus().length} cores · ${(totalmem() / 1024 ** 3).toFixed(0)} GB${RESET}`);
  console.log(`  ${BOLD}   anpan-os${RESET}  ${DIM}v${APP_VERSION} · ${envConfig.RUN_MODE || "source"} · running as ${runningAs()}${RESET}`);
  console.log();

  // ── Service ────────────────────────────────────────────────────────────────
  //
  // The first thing anyone opening a doctor wants to know is whether the thing is running
  // and where to reach it. Reported before the tool list because a stopped service is a
  // more urgent fact than a missing optional binary.
  const [server, svc] = await Promise.all([readConfiguredServer(), service.state("anpan-os")]);

  const runMark = svc.active ? `${GREEN}running${RESET}` : `${YELLOW}not running${RESET}`;
  const pidPart = svc.pid !== null ? ` ${DIM}(pid ${svc.pid})${RESET}` : "";
  const bootPart = svc.enabled ? "" : ` ${DIM}· not enabled at boot${RESET}`;
  console.log(`  ${BOLD}Service${RESET}  ${runMark}${pidPart}${bootPart}  ${DIM}via ${service.label}${RESET}`);

  if (!server.exists) {
    console.log(`  ${BOLD}Config ${RESET}  ${YELLOW}none yet${RESET}  ${DIM}${server.path}${RESET}`);
  } else if (server.port === null) {
    console.log(`  ${BOLD}Config ${RESET}  ${RED}invalid${RESET}  ${DIM}${server.path}${RESET}`);
    console.log(`           ${DIM}└─ ${server.problem}${RESET}`);
  } else {
    console.log(`  ${BOLD}Config ${RESET}  ${DIM}${server.path}${RESET}`);
    // A "local" bind is only reachable from this machine, so offering a LAN URL would be
    // misleading; say which it is rather than printing an address that will not answer.
    const lan = server.bind === "public" ? lanAddress() : null;
    const url = lan ? `http://${lan}:${server.port}` : `http://localhost:${server.port}`;
    const scope = server.bind === "public" ? "all interfaces" : "this machine only";
    console.log(`  ${BOLD}Address${RESET}  ${CYAN}${url}${RESET}  ${DIM}port ${server.port} · ${scope}${RESET}`);
  }
  console.log();

  const results  = await commands.doctor();
  const nameW    = Math.max(...results.map((r) => r.name.length));
  const featureW = Math.max(...results.map((r) => r.feature.length));
  let   missing  = 0;

  let notApplicable = 0;

  for (const r of results) {
    // A tool with no role on this platform is neither present nor a problem — it gets a
    // neutral marker and is excluded from the count entirely.
    const icon = !r.applicable ? `${DIM}–${RESET}`
               : r.available   ? `${GREEN}✔${RESET}`
               :                 `${RED}✘${RESET}`;
    const highlight = r.applicable && !r.available ? RED : "";
    const name    = `${highlight}${r.name.padEnd(nameW)}${RESET}`;
    const feature = `${DIM}${r.feature.padEnd(featureW)}${RESET}`;
    const binary  = r.binary
      ? `${CYAN}(${r.binary})${RESET}`
      : `${DIM}(not used on this platform)${RESET}`;
    console.log(`  ${icon}  ${name}  ${feature}  ${binary}`);

    if (!r.applicable) { notApplicable++; continue; }
    if (!r.available) {
      console.log(`     ${DIM}└─ ${r.installHint}${RESET}`);
      missing++;
    }
  }

  // /usr/sbin/smbd exists on every Mac but is Apple's SMBX, which does not read smb.conf.
  // A bare "smbd ✔" above would read as "Samba works here", so the flavour is spelled out.
  const smb = await detectSamba();
  if (smb.flavor === "apple") {
    console.log(`\n  ${YELLOW}!${RESET}  ${BOLD}SMB${RESET}  ${DIM}${smb.reason}${RESET}`);
  }

  const relevant = results.length - notApplicable;

  console.log();
  if (missing === 0) {
    console.log(
      `${GREEN}${BOLD}All tools available.${RESET} (${relevant}/${relevant})` +
      (notApplicable > 0 ? ` ${DIM}${notApplicable} not used on this platform${RESET}` : "") + "\n",
    );
    process.exit(0);
  } else {
    console.log(
      `${RED}${BOLD}${missing} tool(s) missing.${RESET} ${DIM}(${relevant - missing}/${relevant} available` +
      (notApplicable > 0 ? `, ${notApplicable} not used on this platform` : "") + `)${RESET}\n`,
    );
    process.exit(1);
  }
}
