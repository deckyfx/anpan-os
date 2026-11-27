/**
 * The values anpan-os gives CasaOS-style apps ($AppID, $PUID, $PGID, $TZ) and the data
 * root rewrite for App Store installs.
 */
import { test, expect, describe } from "bun:test";
import { referencedVariables, envKeys, withPlatformDefaults, rewriteDataRoot, platformValues } from "../src/lib/app-env";

const CASAOS = `name: jellyfin
services:
  jellyfin:
    image: linuxserver/jellyfin:latest
    environment:
      PUID: $PUID
      PGID: \${PGID}
      TZ: $TZ
    volumes:
      # config lives with the app's data
      - /DATA/AppData/$AppID/config:/config
      - type: bind
        source: /DATA/AppData/$AppID/cache
        target: /cache
      - /DATA/Media:/media:ro
    command: ["sh", "-c", "echo $$HOME"]
x-casaos:
  title:
    en_us: Jellyfin
`;

describe("referencedVariables", () => {
  test("finds $NAME and ${NAME} forms, and skips $$ escapes", () => {
    const used = referencedVariables(CASAOS);
    expect([...used].sort()).toEqual(["AppID", "PGID", "PUID", "TZ"]);
    expect(used.has("HOME")).toBe(false);
  });

  test("a default or error form still names the variable", () => {
    expect([...referencedVariables("ports: ['${WEB_PORT:-8080}:80', '${X:?required}:81']")].sort()).toEqual(["WEB_PORT", "X"]);
  });
});

describe("withPlatformDefaults", () => {
  test("adds only the values the file uses and .env does not set", () => {
    const { env, added } = withPlatformDefaults("TZ=Europe/Berlin\n", CASAOS, "jellyfin");
    expect(added).toEqual(["AppID", "PUID", "PGID"]);
    expect(env.startsWith("TZ=Europe/Berlin\n")).toBe(true);   // the user's value stays first and unchanged
    expect(envKeys(env)).toEqual(new Set(["TZ", "AppID", "PUID", "PGID"]));
    expect(env).toContain("AppID=jellyfin");
    expect(env).toContain(`PUID=${platformValues("x").PUID}`);
  });

  test("a stack that uses none of them gets an unchanged .env", () => {
    const out = withPlatformDefaults("A=1\n", "services:\n  web:\n    image: nginx\n", "web");
    expect(out).toEqual({ env: "A=1\n", added: [] });
  });

  test("an empty .env gets just the block", () => {
    const { env } = withPlatformDefaults("", "services:\n  a:\n    image: x\n    user: $PUID\n", "a");
    expect(env.split("\n")[0]).toMatch(/^# Filled in by anpan-os/);
    expect(envKeys(env)).toEqual(new Set(["PUID"]));
  });

  test("export prefixes and comments in .env are understood", () => {
    expect(envKeys("# comment\nexport PUID=1\n\nTZ = UTC\nnot a line\n")).toEqual(new Set(["PUID", "TZ"]));
  });
});

describe("rewriteDataRoot", () => {
  test("moves /DATA/AppData sources, short and long syntax, and nothing else", () => {
    const out = rewriteDataRoot(CASAOS, "/srv/apps");
    expect(out).toContain("- /srv/apps/$AppID/config:/config");
    expect(out).toContain("source: /srv/apps/$AppID/cache");
    expect(out).toContain("- /DATA/Media:/media:ro");          // not under AppData: untouched
    expect(out).toContain("# config lives with the app's data");  // comments survive
    expect(out).toContain('command: ["sh", "-c", "echo $$HOME"]'); // flow style survives
  });

  test("returns the text unchanged when the root is CasaOS's own", () => {
    expect(rewriteDataRoot(CASAOS, "/DATA/AppData")).toBe(CASAOS);
  });

  test("a path that only starts with the same letters is not moved", () => {
    const text = "services:\n  a:\n    image: x\n    volumes:\n      - /DATA/AppDataOld/a:/a\n";
    expect(rewriteDataRoot(text, "/srv/apps")).toBe(text);
  });

  test("invalid YAML is returned as it was, for the install's own check to report", () => {
    expect(rewriteDataRoot("services: [", "/srv/apps")).toBe("services: [");
  });
});
