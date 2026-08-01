import { join } from "node:path";
import { config } from "../config";
import { bins } from "../lib/commands";
import {
  scanComposeSources,
  adoptComposeFile,
  buildComposeSourceReport,
  composeFileExistsChecker,
  findOrphanServices,
} from "../lib/compose-source";
import type { ComposeSourceReport } from "../lib/compose-source";

const isTTY  = process.stdout.isTTY;
const RESET  = isTTY ? "\x1b[0m"  : "";
const BOLD   = isTTY ? "\x1b[1m"  : "";
const DIM    = isTTY ? "\x1b[2m"  : "";
const GREEN  = isTTY ? (Bun.color("green",  "ansi") ?? "") : "";
const RED    = isTTY ? (Bun.color("red",    "ansi") ?? "") : "";
const YELLOW = isTTY ? (Bun.color("yellow", "ansi") ?? "") : "";
const CYAN   = isTTY ? (Bun.color("cyan",   "ansi") ?? "") : "";

const BADGE: Record<ComposeSourceReport["status"], string> = {
  ok:       `${GREEN}✔ ok${RESET}`,
  drift:    `${RED}✘ drift${RESET}`,
  mixed:    `${RED}✘ mixed${RESET}`,
  external: `${YELLOW}• external${RESET}`,
  unknown:  `${DIM}? unknown${RESET}`,
};

/** Print one stack's per-container compose sources. */
function printReport(r: ComposeSourceReport): void {
  console.log(`  ${BADGE[r.status]}  ${BOLD}${r.stack}${RESET}`);
  if (r.status === "ok") return;
  console.log(`       ${DIM}expected: ${r.expected}${r.expectedExists ? "" : " (missing)"}${RESET}`);
  for (const c of r.containers) {
    const icon = c.matches ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
    const note = c.dangling ? ` ${RED}(file no longer exists)${RESET}` : "";
    const from = c.configFiles.join(", ") || `${DIM}no compose labels${RESET}`;
    console.log(`       ${icon} ${c.container.padEnd(26)} ${from}${note}`);
  }
}

/**
 * Report which compose file every stack's containers were created from.
 *
 * Exits 0 when nothing needs repair, 1 otherwise, so it can gate a deploy script.
 */
export async function runComposeDoctor(showAll: boolean): Promise<never> {
  console.log(`\n${BOLD}🍞 anpan-os compose doctor${RESET}\n`);
  console.log(`${DIM}Managed compose folder: ${config.composeFolder}${RESET}\n`);

  const reports = await scanComposeSources();
  if (reports.length === 0) {
    console.log(`${YELLOW}No compose projects found (is Docker running?).${RESET}\n`);
    process.exit(0);
  }

  const shown = showAll ? reports : reports.filter(r => r.needsRepair);
  for (const r of shown) printReport(r);

  const broken   = reports.filter(r => r.needsRepair);
  const external = reports.filter(r => r.status === "external");

  console.log();
  if (external.length > 0 && showAll) {
    console.log(`${DIM}${external.length} stack(s) are managed outside anpan-os — not a fault.${RESET}`);
  }
  if (broken.length === 0) {
    console.log(`${GREEN}${BOLD}No compose path drift.${RESET}\n`);
    process.exit(0);
  }

  console.log(`${RED}${BOLD}${broken.length} stack(s) need repair.${RESET}`);
  console.log(`${DIM}Fix with:  anpan-os --compose-repair ${broken.map(b => b.stack).join(" ")}${RESET}`);
  console.log(`${DIM}    or:    anpan-os --compose-repair --all${RESET}\n`);
  process.exit(1);
}

/**
 * Re-anchor stacks onto the managed compose file.
 *
 * Adopts an existing compose file into the managed folder when one is missing, then
 * redeploys with --force-recreate so every container is rebuilt and relabelled. Named
 * volumes and networks survive (the project name is unchanged), but containers are
 * recreated — expect a brief restart per stack.
 */
export async function runComposeRepair(names: string[], all: boolean): Promise<never> {
  const docker = bins.docker;
  if (!docker) {
    console.error(`${RED}Docker is not available on this system.${RESET}`);
    process.exit(1);
  }

  console.log(`\n${BOLD}🍞 anpan-os compose repair${RESET}\n`);
  console.log(`${DIM}Managed compose folder: ${config.composeFolder}${RESET}\n`);

  let targets: ComposeSourceReport[];
  if (all) {
    targets = (await scanComposeSources()).filter(r => r.needsRepair);
  } else {
    // Wrapped rather than passed by reference: Array.map would hand the index in as the
    // `exists` argument. One memo shared across the batch, as in scanComposeSources.
    const exists    = composeFileExistsChecker();
    const requested = await Promise.all(names.map(n => buildComposeSourceReport(n, exists)));
    // Recreating a healthy stack only costs it a restart — skip rather than churn.
    for (const r of requested.filter(r => !r.needsRepair)) {
      console.log(`${DIM}skipping ${r.stack} — already ${r.status}${RESET}`);
    }
    targets = requested.filter(r => r.needsRepair);
  }

  if (targets.length === 0) {
    console.log(`${GREEN}Nothing to repair.${RESET}\n`);
    process.exit(0);
  }

  console.log(`${YELLOW}Recreating containers for ${targets.length} stack(s) — each will restart briefly.${RESET}\n`);

  let failed = 0;
  for (const report of targets) {
    console.log(`${BOLD}${report.stack}${RESET}`);

    const adopted = await adoptComposeFile(report);
    if (!adopted.ok) {
      console.log(`  ${RED}✘ ${adopted.error}${RESET}\n`);
      failed++;
      continue;
    }
    if (adopted.adoptedFrom) {
      console.log(`  ${CYAN}adopted${RESET} ${adopted.adoptedFrom} ${DIM}→${RESET} ${report.expected}`);
    }

    // Guard: --remove-orphans would delete services the managed file does not define.
    const orphanCheck = await findOrphanServices(report);
    if (!orphanCheck.ok) {
      console.log(`  ${RED}✘ ${orphanCheck.error}${RESET}\n`);
      failed++;
      continue;
    }
    if (orphanCheck.orphans.length > 0) {
      console.log(`  ${RED}✘ refusing to repair — these running services are not in the managed file:${RESET}`);
      for (const o of orphanCheck.orphans) console.log(`       ${RED}${o}${RESET}`);
      console.log(`     ${DIM}Repairing would delete them. Merge them into ${report.expected} first.${RESET}\n`);
      failed++;
      continue;
    }

    const stackDir = join(config.composeFolder, report.stack);
    const result = await Bun.$`${docker} compose up -d --remove-orphans --force-recreate`
      .cwd(stackDir)
      .nothrow()
      .quiet();

    if (result.exitCode !== 0) {
      console.log(`  ${RED}✘ docker compose failed (exit ${result.exitCode})${RESET}`);
      console.log(`${DIM}${result.stderr.toString().trim()}${RESET}\n`);
      failed++;
      continue;
    }

    // Re-read labels to prove the containers now carry the managed path.
    const after = await buildComposeSourceReport(report.stack);
    if (after.status === "ok") {
      console.log(`  ${GREEN}✔ all containers now point at ${after.expected}${RESET}\n`);
    } else {
      console.log(`  ${YELLOW}⚠ still ${after.status} after repair — inspect manually${RESET}\n`);
      failed++;
    }
  }

  if (failed > 0) {
    console.log(`${RED}${BOLD}${failed} stack(s) could not be repaired.${RESET}\n`);
    process.exit(1);
  }
  console.log(`${GREEN}${BOLD}All stacks repaired.${RESET}\n`);
  process.exit(0);
}
