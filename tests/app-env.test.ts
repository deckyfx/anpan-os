/**
 * The values anpan-os gives CasaOS-style apps ($AppID, $PUID, $PGID, $TZ) and the data
 * root rewrite for App Store installs.
 */
import { test, expect, describe } from "bun:test";
import { referencedVariables, envKeys, envValue, resolvedEnvValue, withPlatformDefaults, rewriteDataRoot, platformValues } from "../src/lib/app-env";

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

  test("a KEY: value assignment counts as set, so no default is added over it", () => {
    const { env, added } = withPlatformDefaults("PUID: 2001\n", "services:\n  a:\n    image: x\n    user: $PUID\n", "a");
    expect(added).toEqual([]);
    expect(env).toBe("PUID: 2001\n");
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

  test("volumes shared through a YAML anchor are rewritten once, where they are defined", () => {
    const text = "x-vols: &vols\n  - /DATA/AppData/app/config:/config\nservices:\n  a:\n    image: x\n    volumes: *vols\n  b:\n    image: y\n    volumes: *vols\n";
    const out = rewriteDataRoot(text, "/srv/apps");
    expect(out).toContain("&vols\n  - /srv/apps/app/config:/config");
    expect(out.match(/\/srv\/apps/g)?.length).toBe(1);
    expect(out).toContain("volumes: *vols");
  });

  test("an anonymous volume (a container path only) is not mistaken for a host path", () => {
    const text = "services:\n  a:\n    image: x\n    volumes:\n      - /DATA/AppData/cache\n";
    expect(rewriteDataRoot(text, "/srv/apps")).toBe(text);
  });

  test("a long-form source given by an alias is rewritten for that volume; the anchor keeps its value", () => {
    const text = "x-paths:\n  config: &src /DATA/AppData/app/config\nservices:\n  a:\n    image: x\n    volumes:\n      - type: bind\n        source: *src\n        target: /config\n";
    const out = rewriteDataRoot(text, "/srv/apps");
    expect(out).toContain("source: /srv/apps/app/config");
    expect(out).toContain("config: &src /DATA/AppData/app/config");
  });

  test("invalid YAML is returned as it was, for the install's own check to report", () => {
    expect(rewriteDataRoot("services: [", "/srv/apps")).toBe("services: [");
  });
});

describe("reading .env as Compose does", () => {
  test("an unquoted value ends at an inline comment; a quoted one keeps its #", () => {
    expect(envValue("PUID=2001 # app user\n", "PUID")).toBe("2001");
    expect(envValue('PASS="a #b" # note\n', "PASS")).toBe("a #b");
    expect(envValue("TAG=v1#2\n", "TAG")).toBe("v1#2");     // no space before #: not a comment
  });

  test("lines inside a multi-line quoted value are not assignments", () => {
    const env = "NOTES='header\nTZ=Europe/Berlin\nfooter'\nA=1\n";
    expect(envKeys(env)).toEqual(new Set(["NOTES", "A"]));
    expect(envValue(env, "NOTES")).toBe("header\nTZ=Europe/Berlin\nfooter");
    const { added } = withPlatformDefaults(env, "services:\n  a:\n    environment:\n      TZ: $TZ\n", "app");
    expect(added).toContain("TZ");
  });

  test("an escaped quote does not end a quoted value", () => {
    const env = "NOTES='it\\'s\nTZ=Europe/Berlin\nfooter'\nA=1\n";
    expect(envKeys(env)).toEqual(new Set(["NOTES", "A"]));
  });

  test("paired backslashes escape each other, so the quote after them closes the value", () => {
    const env = 'NOTES="C:\\\\"\nPUID=2001\nPGID=2001\n';
    expect(envValue(env, "NOTES")).toBe("C:\\\\");
    expect(envValue(env, "PUID")).toBe("2001");
    expect(envKeys(env)).toEqual(new Set(["NOTES", "PUID", "PGID"]));
  });

  test("references are substituted as Compose does: shell first, then earlier lines; single quotes stay literal", () => {
    expect(resolvedEnvValue("PUID=${APP_UID:-2001}\n", "PUID", {})).toBe("2001");
    expect(resolvedEnvValue("PUID=${APP_UID:-2001}\n", "PUID", { APP_UID: "3000" })).toBe("3000");
    expect(resolvedEnvValue("BASE=4000\nPUID=$BASE\n", "PUID", {})).toBe("4000");
    expect(resolvedEnvValue('PUID="${A-${B:-5}}"\n', "PUID", {})).toBe("5");
    expect(resolvedEnvValue("PUID='${APP_UID:-2001}'\n", "PUID", {})).toBe("${APP_UID:-2001}");
    expect(resolvedEnvValue("P=$$HOME\n", "P", {})).toBe("$HOME");
    expect(resolvedEnvValue("A=1\n", "PUID", {})).toBeNull();
  });

  test("a real TZ assignment still counts as set", () => {
    const { added } = withPlatformDefaults("TZ=Asia/Tokyo\n", "services:\n  a:\n    environment:\n      TZ: $TZ\n", "app");
    expect(added).not.toContain("TZ");
  });
});
