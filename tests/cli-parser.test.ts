import { test, expect, describe } from "bun:test";
import { parseCli } from "../src/cli-parser";

/**
 * Anything the parser did not recognise used to mean "start the server". `anpan-os upgrade`
 * — no such command — therefore launched a full server in the current directory. These pin
 * the rule that replaced it: only a bare `anpan-os` serves; everything else is a known
 * command or an error.
 */

describe("parseCli", () => {
  test("no arguments starts the server, as every installed service runs it", () => {
    expect(parseCli([])).toEqual({ type: "serve" });
  });

  test("an unknown word is an error, with a hint when it names a command", () => {
    expect(parseCli(["upgrade"])).toEqual({ type: "invalid", message: "Unknown command: upgrade. Did you mean --upgrade?" });
    expect(parseCli(["frobnicate"])).toEqual({ type: "invalid", message: "Unknown command: frobnicate." });
  });

  test("names every object inherits are unknown words too, not modifiers", () => {
    // `in` matched the prototype chain, so these passed as modifiers and started the server.
    for (const word of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      expect(parseCli([word]).type).toBe("invalid");
    }
  });

  test("an unknown option is an error, never the server", () => {
    expect(parseCli(["--upgarde"]).type).toBe("invalid");
    expect(parseCli(["--port", "5000"]).type).toBe("invalid");
  });

  test("--upgrade, and --check to only report", () => {
    expect(parseCli(["--upgrade"])).toEqual({ type: "upgrade", checkOnly: false });
    expect(parseCli(["--upgrade", "--check"])).toEqual({ type: "upgrade", checkOnly: true });
    expect(parseCli(["--check", "--upgrade"])).toEqual({ type: "upgrade", checkOnly: true });
  });

  test("a modifier without its command is an error", () => {
    expect(parseCli(["--check"])).toEqual({ type: "invalid", message: "--check only goes with --upgrade." });
    expect(parseCli(["--all"]).type).toBe("invalid");
  });

  test("stack names are allowed after --compose-repair, and only there", () => {
    expect(parseCli(["--compose-repair", "jellyfin", "sonarr"])).toEqual({ type: "compose-repair", stacks: ["jellyfin", "sonarr"], all: false });
    expect(parseCli(["--compose-repair", "--all"])).toEqual({ type: "compose-repair", stacks: [], all: true });
    expect(parseCli(["--compose-repair"]).type).toBe("invalid");
    expect(parseCli(["jellyfin", "--compose-repair"]).type).toBe("invalid");   // before it, a stray word
  });

  test("existing commands are unchanged", () => {
    expect(parseCli(["-v"])).toEqual({ type: "version" });
    expect(parseCli(["--help"])).toEqual({ type: "help" });
    expect(parseCli(["--doctor"])).toEqual({ type: "doctor" });
    expect(parseCli(["--compose-doctor", "--all"])).toEqual({ type: "compose-doctor", all: true });
    expect(parseCli(["--reset-user"])).toEqual({ type: "reset-user" });
  });
});
