import { commands } from "../lib/commands";
import { PLATFORM_LABEL, detectSamba } from "../lib/platform";

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
  console.log(`${DIM}Checking required external tools on ${PLATFORM_LABEL}…${RESET}\n`);

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
