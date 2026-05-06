import { commands } from "../lib/commands";

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
  console.log(`${DIM}Checking required external tools on ${process.platform}…${RESET}\n`);

  const results  = await commands.doctor();
  const nameW    = Math.max(...results.map((r) => r.name.length));
  const featureW = Math.max(...results.map((r) => r.feature.length));
  let   missing  = 0;

  for (const r of results) {
    const icon    = r.available ? `${GREEN}✔${RESET}` : `${RED}✘${RESET}`;
    const name    = `${r.available ? "" : RED}${r.name.padEnd(nameW)}${RESET}`;
    const feature = `${DIM}${r.feature.padEnd(featureW)}${RESET}`;
    const binary  = r.binary
      ? `${CYAN}(${r.binary})${RESET}`
      : `${YELLOW}(n/a on ${process.platform})${RESET}`;
    console.log(`  ${icon}  ${name}  ${feature}  ${binary}`);
    if (!r.available) {
      console.log(`     ${DIM}└─ ${r.installHint}${RESET}`);
      missing++;
    }
  }

  console.log();
  if (missing === 0) {
    console.log(`${GREEN}${BOLD}All tools available.${RESET} (${results.length}/${results.length})\n`);
    process.exit(0);
  } else {
    console.log(`${RED}${BOLD}${missing} tool(s) missing.${RESET} ${DIM}(${results.length - missing}/${results.length} available)${RESET}\n`);
    process.exit(1);
  }
}
