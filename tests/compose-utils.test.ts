/**
 * Guided stack editor: compose YAML ↔ form model.
 *
 * The editor must write form edits into the YAML in place: anything the form
 * does not model (x-casaos, ulimits, comments, long-form depends_on, CMD
 * healthchecks, array commands...) has to survive untouched, and a field the
 * user did not change must not be rewritten.
 *
 * Run: bun test tests/compose-utils.test.ts
 */
import { describe, expect, test } from "bun:test";
import { parse } from "yaml";
import {
  formatArgs, parseComposeDoc, parsePortEntry, parseService, parseStackConfig, parseVolumeEntry,
  placeholderMask, splitArgs, splitImageRef, splitOutsideVars,
} from "../src/public/app/pages/home/guided/composeUtils";
import { applyFormChanges, type FormSnapshot } from "../src/public/app/pages/home/guided/composePatch";
import type { ServiceForm } from "../src/public/app/pages/home/guided/types";

// A CasaOS-style file with the things the old rebuild lost. The layout is
// deliberately not what the yaml printer produces (unindented sequences,
// comment spacing, flow brackets) so byte-for-byte preservation is tested.
const CASAOS = `# Jellyfin, from the CasaOS app store
name: jellyfin
services:
  jellyfin:
    image: linuxserver/jellyfin:10.8.13   # pinned
    container_name: jellyfin
    hostname: jellyfin
    env_file: .env
    cpu_shares: 90
    shm_size: 256m
    security_opt:
    - no-new-privileges:true
    environment:
      PUID: 1000
      PGID: "1000"
      TZ: Etc/UTC
    ports:
    - "8096:8096"
    - target: 7359
      published: 7359
      protocol: udp
    volumes:
    - /DATA/AppData/jellyfin/config:/config
    - /DATA/Media:/media:ro,z
    command: ["--ffmpeg", "/usr/lib/jellyfin-ffmpeg/ffmpeg", "--log-level=info"]
    ulimits:
      nofile:
        soft: 65536
        hard: 65536
    sysctls:
      net.core.somaxconn: 1024
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8096/health"]
      interval: 30s
      start_period: 40s
    depends_on:
      db:
        condition: service_healthy
    networks:
      default:
        aliases: [media]
    restart: unless-stopped
    x-casaos:
      envs:
      - container: TZ
        description:
          en_us: TimeZone
  db:
    image: postgres:16
    environment:
    - POSTGRES_PASSWORD=secret
    restart: always

networks:
  default:
    name: jellyfin_net

x-casaos:
  architectures:
  - amd64
  - arm64
  main: jellyfin
  title:
    en_us: Jellyfin
  port_map: "8096"
`;

/** What the dialog holds right after reading a file. */
function snapshot(yaml: string): FormSnapshot {
  const doc   = parseComposeDoc(yaml);
  const names = Object.keys(doc.services);
  return {
    serviceNames: names,
    serviceForms: Object.fromEntries(names.map(n => [n, parseService(doc.services[n])])),
    stackConfig:  parseStackConfig(doc),
  };
}

/** A copy of `snap` with one service's form edited. */
function editService(snap: FormSnapshot, name: string, edit: (f: ServiceForm) => ServiceForm): FormSnapshot {
  return { ...snap, serviceForms: { ...snap.serviceForms, [name]: edit(snap.serviceForms[name]!) } };
}

/**
 * Lines added and removed between two texts, as multisets (a line that
 * appears once more counts as added), in the order they appear.
 */
function lineDiff(before: string, after: string): { added: string[]; removed: string[] } {
  const minus = (xs: string[], ys: string[]) => {
    const left = new Map<string, number>();
    for (const y of ys) left.set(y, (left.get(y) ?? 0) + 1);
    return xs.filter(x => {
      const n = left.get(x) ?? 0;
      if (n > 0) { left.set(x, n - 1); return false; }
      return true;
    });
  };
  const b = before.split("\n");
  const a = after.split("\n");
  return { added: minus(a, b), removed: minus(b, a) };
}

// ─── No-op ────────────────────────────────────────────────────────────────────

describe("applyFormChanges — no-op", () => {
  test("an untouched form leaves the text byte-for-byte unchanged", () => {
    const base = snapshot(CASAOS);
    expect(applyFormChanges(CASAOS, base, snapshot(CASAOS))).toBe(CASAOS);
  });

  test("a half-filled row the user added (no key yet) writes nothing", () => {
    const base = snapshot(CASAOS);
    const next = editService(base, "jellyfin", f => ({ ...f, environment: [...f.environment, { key: "", value: "" }] }));
    expect(applyFormChanges(CASAOS, base, next)).toBe(CASAOS);
  });

  test("forms reparsed from the file round-trip everything they show", () => {
    const f = snapshot(CASAOS).serviceForms.jellyfin!;
    expect(f.command).toBe("--ffmpeg /usr/lib/jellyfin-ffmpeg/ffmpeg --log-level=info");
    expect(f.healthcheckTest).toBe("curl -f http://localhost:8096/health");
    expect(f.dependsOn).toEqual(["db"]);
    expect(f.networks).toEqual(["default"]);
  });
});

// ─── Single-field edits ───────────────────────────────────────────────────────

describe("applyFormChanges — one field changes only that field", () => {
  test("environment variable value (map form, number stays a number)", () => {
    const base = snapshot(CASAOS);
    const next = editService(base, "jellyfin", f => ({
      ...f, environment: f.environment.map(e => e.key === "PUID" ? { ...e, value: "1001" } : e),
    }));
    const out = applyFormChanges(CASAOS, base, next);
    expect(lineDiff(CASAOS, out)).toEqual({ added: ["      PUID: 1001"], removed: ["      PUID: 1000"] });
  });

  test("quoted environment value keeps its quotes", () => {
    const base = snapshot(CASAOS);
    const next = editService(base, "jellyfin", f => ({
      ...f, environment: f.environment.map(e => e.key === "PGID" ? { ...e, value: "1002" } : e),
    }));
    expect(lineDiff(CASAOS, applyFormChanges(CASAOS, base, next)))
      .toEqual({ added: ['      PGID: "1002"'], removed: ['      PGID: "1000"'] });
  });

  test("list-form environment in another service", () => {
    const base = snapshot(CASAOS);
    const next = editService(base, "db", f => ({ ...f, environment: [{ key: "POSTGRES_PASSWORD", value: "hunter2" }] }));
    expect(lineDiff(CASAOS, applyFormChanges(CASAOS, base, next)))
      .toEqual({ added: ["    - POSTGRES_PASSWORD=hunter2"], removed: ["    - POSTGRES_PASSWORD=secret"] });
  });

  test("adding an environment variable to a map adds one line in map form", () => {
    const base = snapshot(CASAOS);
    const next = editService(base, "jellyfin", f => ({ ...f, environment: [...f.environment, { key: "UMASK", value: "022" }] }));
    const out  = applyFormChanges(CASAOS, base, next);
    expect(lineDiff(CASAOS, out)).toEqual({ added: ["      UMASK: \"022\""], removed: [] });
    expect(out.indexOf("UMASK")).toBeGreaterThan(out.indexOf("TZ: Etc/UTC"));
  });

  test("short-syntax port keeps its quotes; long-syntax port stays long", () => {
    const base = snapshot(CASAOS);
    const next = editService(base, "jellyfin", f => ({
      ...f,
      ports: [{ ...f.ports[0]!, host: "8097" }, { ...f.ports[1]!, host: "7360" }],
    }));
    expect(lineDiff(CASAOS, applyFormChanges(CASAOS, base, next))).toEqual({
      added:   ['    - "8097:8096"', "      published: 7360"],
      removed: ['    - "8096:8096"', "      published: 7359"],
    });
  });

  test("image tag", () => {
    const base = snapshot(CASAOS);
    const next = editService(base, "jellyfin", f => ({ ...f, imageTag: "10.9.0" }));
    expect(lineDiff(CASAOS, applyFormChanges(CASAOS, base, next))).toEqual({
      added:   ["    image: linuxserver/jellyfin:10.9.0 # pinned"],
      removed: ["    image: linuxserver/jellyfin:10.8.13   # pinned"],
    });
  });

  test("an explicit :latest tag stays explicit", () => {
    const yaml = "services:\n  app:\n    image: nginx:1.25\n";
    const base = snapshot(yaml);
    const next = editService(base, "app", f => ({ ...f, imageTag: "latest" }));
    expect(applyFormChanges(yaml, base, next)).toBe("services:\n  app:\n    image: nginx:latest\n");
  });

  test("short-syntax volume keeps an options suffix the form cannot show", () => {
    const base = snapshot(CASAOS);
    const next = editService(base, "jellyfin", f => ({
      ...f, volumes: f.volumes.map(v => v.container === "/media" ? { ...v, host: "/mnt/media" } : v),
    }));
    expect(lineDiff(CASAOS, applyFormChanges(CASAOS, base, next)))
      .toEqual({ added: ["    - /mnt/media:/media:ro,z"], removed: ["    - /DATA/Media:/media:ro,z"] });
  });

  test("healthcheck interval keeps the CMD test and start_period", () => {
    const base = snapshot(CASAOS);
    const next = editService(base, "jellyfin", f => ({ ...f, healthcheckInterval: "1m" }));
    expect(lineDiff(CASAOS, applyFormChanges(CASAOS, base, next)))
      .toEqual({ added: ["      interval: 1m"], removed: ["      interval: 30s"] });
  });

  test("editing a CMD healthcheck test keeps CMD form when it splits cleanly", () => {
    const base = snapshot(CASAOS);
    const next = editService(base, "jellyfin", f => ({ ...f, healthcheckTest: "curl -fsS http://localhost:8096/health" }));
    const out  = applyFormChanges(CASAOS, base, next);
    expect(lineDiff(CASAOS, out)).toEqual({
      added:   ['      test: ["CMD", "curl", "-fsS", "http://localhost:8096/health"]'],
      removed: ['      test: ["CMD", "curl", "-f", "http://localhost:8096/health"]'],
    });
  });

  test("a CMD test with unbalanced quotes becomes CMD-SHELL", () => {
    const base = snapshot(CASAOS);
    const next = editService(base, "jellyfin", f => ({ ...f, healthcheckTest: `curl "oops` }));
    const svc  = (parse(applyFormChanges(CASAOS, base, next)) as { services: Record<string, { healthcheck: { test: string[] } }> }).services.jellyfin!;
    expect(svc.healthcheck.test).toEqual(["CMD-SHELL", `curl "oops`]);
  });

  test("restart policy, and depends_on/networks/x-casaos untouched", () => {
    const base = snapshot(CASAOS);
    const next = editService(base, "jellyfin", f => ({ ...f, restart: "always" }));
    expect(lineDiff(CASAOS, applyFormChanges(CASAOS, base, next)))
      .toEqual({ added: ["    restart: always"], removed: ["    restart: unless-stopped"] });
  });

  test("memory limit goes under deploy when the file has none", () => {
    const base = snapshot(CASAOS);
    const next = editService(base, "db", f => ({ ...f, memLimitMb: 512 }));
    const svc  = (parse(applyFormChanges(CASAOS, base, next)) as { services: Record<string, Record<string, unknown>> }).services.db!;
    expect(svc.deploy).toEqual({ resources: { limits: { memory: "512m" } } });
  });

  test("memory limit updates mem_limit in place when the file uses it", () => {
    const yaml = "services:\n  app:\n    image: nginx\n    mem_limit: 256m\n";
    const base = snapshot(yaml);
    const next = editService(base, "app", f => ({ ...f, memLimitMb: 1024 }));
    expect(applyFormChanges(yaml, base, next)).toBe("services:\n  app:\n    image: nginx\n    mem_limit: 1024m\n");
  });

  test("clearing a field removes the key and any parent left empty", () => {
    const yaml = "services:\n  app:\n    image: nginx\n    deploy:\n      resources:\n        limits:\n          cpus: \"0.5\"\n";
    const base = snapshot(yaml);
    const next = editService(base, "app", f => ({ ...f, cpuLimit: 0 }));
    expect(applyFormChanges(yaml, base, next)).toBe("services:\n  app:\n    image: nginx\n");
  });

  test("adding a dependency to long-form depends_on keeps the long form", () => {
    const yaml = "services:\n  web:\n    image: nginx\n    depends_on:\n      db:\n        condition: service_healthy\n  db:\n    image: postgres\n  cache:\n    image: redis\n";
    const base = snapshot(yaml);
    const next = editService(base, "web", f => ({ ...f, dependsOn: ["db", "cache"] }));
    const web  = (parse(applyFormChanges(yaml, base, next)) as { services: Record<string, Record<string, unknown>> }).services.web!;
    expect(web.depends_on).toEqual({ db: { condition: "service_healthy" }, cache: { condition: "service_started" } });
  });

  test("stack name change edits only the name line", () => {
    const base = snapshot(CASAOS);
    const next = { ...base, stackConfig: { ...base.stackConfig, name: "my-jellyfin" } };
    expect(lineDiff(CASAOS, applyFormChanges(CASAOS, base, next)))
      .toEqual({ added: ["name: my-jellyfin"], removed: ["name: jellyfin"] });
  });

  test("a new stack name goes to the top of the file", () => {
    const yaml = "services:\n  app:\n    image: nginx\n";
    const base = snapshot(yaml);
    const next = { ...base, stackConfig: { ...base.stackConfig, name: "demo" } };
    expect(applyFormChanges(yaml, base, next)).toBe("name: demo\nservices:\n  app:\n    image: nginx\n");
  });

  test("a top-level network edit keeps its unmodelled keys", () => {
    const base = snapshot(CASAOS);
    const next = { ...base, stackConfig: { ...base.stackConfig, networks: [{ ...base.stackConfig.networks[0]!, driver: "bridge" }] } };
    const out  = applyFormChanges(CASAOS, base, next);
    expect((parse(out) as { networks: unknown }).networks).toEqual({ default: { name: "jellyfin_net", driver: "bridge" } });
    expect(lineDiff(CASAOS, out)).toEqual({ added: ["    driver: bridge"], removed: [] });
  });

  test("removing a middle list item keeps the items around it as written", () => {
    const yaml = "services:\n  app:\n    image: nginx\n    volumes:\n      - ./a:/a   # first\n      - ./b:/b\n      - type: bind\n        source: ./c\n        target: /c\n";
    const base = snapshot(yaml);
    const next = editService(base, "app", f => ({ ...f, volumes: [f.volumes[0]!, f.volumes[2]!] }));
    expect(lineDiff(yaml, applyFormChanges(yaml, base, next))).toEqual({ added: [], removed: ["      - ./b:/b"] });
  });

  test("removing a dependency from long-form depends_on drops only that entry", () => {
    const yaml = "services:\n  web:\n    image: nginx\n    depends_on:\n      db:\n        condition: service_healthy\n      cache:\n        condition: service_started\n        restart: true\n";
    const base = snapshot(yaml);
    const next = editService(base, "web", f => ({ ...f, dependsOn: ["cache"] }));
    expect(lineDiff(yaml, applyFormChanges(yaml, base, next)))
      .toEqual({ added: [], removed: ["      db:", "        condition: service_healthy"] });
  });

  test("hand edits made in the YAML tab since the last read survive a form write", () => {
    const base   = snapshot(CASAOS);
    const edited = CASAOS.replace("TZ: Etc/UTC", "TZ: Asia/Tokyo");
    const next   = editService(base, "jellyfin", f => ({ ...f, imageTag: "10.9.0" }));
    const out    = applyFormChanges(edited, base, next);
    expect(out).toContain("TZ: Asia/Tokyo");
    expect(out).toContain("linuxserver/jellyfin:10.9.0");
  });
});

// ─── Command / entrypoint arrays ──────────────────────────────────────────────

describe("applyFormChanges — array command", () => {
  test("editing one argument keeps the array and the other elements", () => {
    const base = snapshot(CASAOS);
    const next = editService(base, "jellyfin", f => ({ ...f, command: f.command.replace("info", "debug") }));
    expect(lineDiff(CASAOS, applyFormChanges(CASAOS, base, next))).toEqual({
      added:   ['    command: ["--ffmpeg", "/usr/lib/jellyfin-ffmpeg/ffmpeg", "--log-level=debug"]'],
      removed: ['    command: ["--ffmpeg", "/usr/lib/jellyfin-ffmpeg/ffmpeg", "--log-level=info"]'],
    });
  });

  test("an element with spaces is shown quoted and survives an edit elsewhere", () => {
    const yaml = "services:\n  app:\n    image: alpine\n    command:\n      - sh\n      - -c\n      - echo hello && sleep 1\n";
    const base = snapshot(yaml);
    expect(base.serviceForms.app!.command).toBe('sh -c "echo hello && sleep 1"');
    const next = editService(base, "app", f => ({ ...f, command: 'sh -c "echo bye && sleep 1"' }));
    expect(applyFormChanges(yaml, base, next))
      .toBe("services:\n  app:\n    image: alpine\n    command:\n      - sh\n      - -c\n      - echo bye && sleep 1\n");
  });

  test("an array edit with unbalanced quotes is rejected, not saved as a string compose cannot split", () => {
    const yaml = 'services:\n  app:\n    image: alpine\n    command: ["sleep", "1"]\n';
    const base = snapshot(yaml);
    const next = editService(base, "app", f => ({ ...f, command: "sleep 'unterminated" }));
    expect(() => applyFormChanges(yaml, base, next)).toThrow(/command.*unbalanced quotes/);
  });

  test("a string command stays a string", () => {
    const yaml = "services:\n  app:\n    image: alpine\n    command: sleep 10\n";
    const base = snapshot(yaml);
    const next = editService(base, "app", f => ({ ...f, command: "sleep 20" }));
    expect(applyFormChanges(yaml, base, next)).toBe("services:\n  app:\n    image: alpine\n    command: sleep 20\n");
  });

  test("splitArgs / formatArgs are inverses", () => {
    const arrays = [["a"], ["sh", "-c", "echo 'x' \"y\""], ["--opt=a b", ""], ["${CMD:-a b}", "x"]];
    for (const a of arrays) expect(splitArgs(formatArgs(a))).toEqual(a);
    expect(splitArgs('a "b')).toBeNull();
  });
});

// ─── Adding / removing / renaming services ────────────────────────────────────

describe("applyFormChanges — services", () => {
  test("adding a service appends it and leaves the rest alone", () => {
    const base = snapshot(CASAOS);
    const redis: ServiceForm = { ...parseService({}), imageName: "redis", imageTag: "7", restart: "always" };
    const next = { ...base, serviceNames: [...base.serviceNames, "cache"], serviceForms: { ...base.serviceForms, cache: redis } };
    const out  = applyFormChanges(CASAOS, base, next);
    const { added, removed } = lineDiff(CASAOS, out);
    expect(removed).toEqual([]);
    expect(added).toEqual(["  cache:", "    image: redis:7", "    restart: always"]);
    expect((parse(out) as { services: Record<string, unknown> }).services.cache).toEqual({ image: "redis:7", restart: "always" });
  });

  test("removing a service removes only its lines", () => {
    const base = snapshot(CASAOS);
    const next = { ...base, serviceNames: ["jellyfin"], serviceForms: { jellyfin: base.serviceForms.jellyfin! } };
    const out  = applyFormChanges(CASAOS, base, next);
    const { added, removed } = lineDiff(CASAOS, out);
    expect(added).toEqual([]);
    expect(removed).toEqual(["  db:", "    image: postgres:16", "    environment:", "    - POSTGRES_PASSWORD=secret", "    restart: always"]);
  });

  test("a renamed service keeps all of its keys and its place", () => {
    const base = snapshot(CASAOS);
    const next = { ...base, serviceNames: ["media", "db"], serviceForms: { media: base.serviceForms.jellyfin!, db: base.serviceForms.db! } };
    const out  = applyFormChanges(CASAOS, base, next, { jellyfin: "media" });
    expect(out).toBe(CASAOS.replace("  jellyfin:\n", "  media:\n"));
  });
});

// ─── Variable placeholders ────────────────────────────────────────────────────

describe("placeholders survive parsing", () => {
  test("placeholderMask covers nested placeholders and skips $$ escapes", () => {
    const s    = "a${A:-${B}}:b$${C}";
    const mask = placeholderMask(s).map(m => (m ? "x" : "."));
    expect(mask.join("")).toBe(".xxxxxxxxxx.......");
    expect(splitOutsideVars("${A:-${B:-x}}:y:$${z}", ":")).toEqual(["${A:-${B:-x}}", "y", "$${z}"]);
  });

  test("volumes", () => {
    expect(parseVolumeEntry("${APPDATA:-/DATA}/app:/config"))
      .toEqual({ host: "${APPDATA:-/DATA}/app", container: "/config", mode: "" });
    expect(parseVolumeEntry("${A:-/x}:/c:ro")).toEqual({ host: "${A:-/x}", container: "/c", mode: "ro" });
    expect(parseVolumeEntry({ type: "bind", source: "${A:-/x}", target: "/c", read_only: true }))
      .toEqual({ host: "${A:-/x}", container: "/c", mode: "ro" });
    expect(parseVolumeEntry("/anonymous")).toEqual({ host: "", container: "/anonymous", mode: "" });
  });

  test("ports", () => {
    expect(parsePortEntry("${PORT:-8080}:${CPORT:-80}")).toEqual({ host: "${PORT:-8080}", container: "${CPORT:-80}", protocol: "tcp" });
    expect(parsePortEntry("${P:-8080}:80/udp")).toEqual({ host: "${P:-8080}", container: "80", protocol: "udp" });
    expect(parsePortEntry("${HOST_IP:-0.0.0.0}:${P:-80}:80"))
      .toEqual({ host: "${HOST_IP:-0.0.0.0}:${P:-80}", container: "80", protocol: "tcp" });
    expect(parsePortEntry("${P:?port required}:80")).toEqual({ host: "${P:?port required}", container: "80", protocol: "tcp" });
  });

  test("image references", () => {
    expect(splitImageRef("nginx:${TAG:-1.2}")).toEqual({ name: "nginx", tag: "${TAG:-1.2}" });
    expect(splitImageRef("${IMAGE:-nginx}:${TAG:-latest}")).toEqual({ name: "${IMAGE:-nginx}", tag: "${TAG:-latest}" });
    expect(splitImageRef("localhost:5000/app:${TAG}")).toEqual({ name: "localhost:5000/app", tag: "${TAG}" });
    expect(splitImageRef("localhost:5000/app")).toEqual({ name: "localhost:5000/app", tag: null });
    expect(splitImageRef("${REG:-ghcr.io}/org/app")).toEqual({ name: "${REG:-ghcr.io}/org/app", tag: null });
    expect(splitImageRef("repo@sha256:abc")).toEqual({ name: "repo@sha256:abc", tag: null });
  });

  test("environment and labels", () => {
    const f = parseService({
      environment: ["DSN=${DB_URL:-postgres://u:p@h/db?a=b}", "BARE"],
      labels:      ["traefik.http.routers.x.rule=Host(`${HOST:-x.local}`)"],
    });
    expect(f.environment).toEqual([{ key: "DSN", value: "${DB_URL:-postgres://u:p@h/db?a=b}" }, { key: "BARE", value: null }]);
    expect(f.labels).toEqual([{ key: "traefik.http.routers.x.rule", value: "Host(`${HOST:-x.local}`)" }]);
  });

  test("placeholders round-trip unchanged through parse → form → in-place write", () => {
    const yaml = [
      "services:",
      "  app:",
      "    image: ${IMAGE:-nginx}:${TAG:-latest}",
      "    user: ${PUID:-1000}:${PGID:-1000}",
      "    environment:",
      "      - DSN=${DB_URL:-postgres://u:p@h/db}",
      "    ports:",
      "      - ${HOST_IP:-0.0.0.0}:${P:-80}:80",
      "      - ${P2:-8080}:80/udp",
      "    volumes:",
      "      - ${APPDATA:-/DATA}/app:/config",
      "      - ${A:-/x}:/c:ro",
      "",
    ].join("\n");
    const base = snapshot(yaml);
    // An unrelated edit forces a write of the service; every placeholder must come through as it was
    const next = editService(base, "app", f => ({ ...f, containerName: "app" }));
    const out  = applyFormChanges(yaml, base, next);
    expect(lineDiff(yaml, out)).toEqual({ added: ["    container_name: app"], removed: [] });

    // Re-parsing the written file gives the same form (the form round-trips placeholders)
    const again = snapshot(out).serviceForms.app!;
    expect({ ...again, containerName: "" }).toEqual(base.serviceForms.app!);

    // Editing a port next to placeholders rewrites only that entry, placeholders intact
    const portEdit = editService(base, "app", f => ({ ...f, ports: [f.ports[0]!, { ...f.ports[1]!, container: "81" }] }));
    expect(lineDiff(yaml, applyFormChanges(yaml, base, portEdit)))
      .toEqual({ added: ["      - ${P2:-8080}:81/udp"], removed: ["      - ${P2:-8080}:80/udp"] });
  });
});

// ─── Layout preservation fallbacks ────────────────────────────────────────────

describe("applyFormChanges — layout", () => {
  test("a 4-space indented file stays 4-space", () => {
    const yaml = "services:\n    app:\n        image: nginx:1\n        ports:\n            - \"80:80\"\n";
    const base = snapshot(yaml);
    const next = editService(base, "app", f => ({ ...f, imageTag: "2" }));
    expect(applyFormChanges(yaml, base, next)).toBe(yaml.replace("nginx:1", "nginx:2"));
  });

  test("invalid YAML throws instead of silently rebuilding", () => {
    const base = snapshot("services:\n  app:\n    image: nginx\n");
    expect(() => applyFormChanges("services: [\n", base, base)).toThrow();
  });
});

// ─── Review regressions ───────────────────────────────────────────────────────

type ParsedCompose = { services: Record<string, Record<string, unknown>>; networks?: Record<string, unknown> };
const svcOf = (yaml: string, name: string) => (parse(yaml) as ParsedCompose).services[name]!;

describe("applyFormChanges — YAML edited by hand since the last read", () => {
  test("a list edit applies the form's changes to the current rows, keeping a hand edit to another row", () => {
    const yaml   = "services:\n  app:\n    image: nginx\n    environment:\n      MODE: blue\n";
    const base   = snapshot(yaml);
    const edited = yaml.replace("MODE: blue", "MODE: green");
    const next   = editService(base, "app", f => ({ ...f, environment: [...f.environment, { key: "FEATURE", value: "on" }] }));
    expect(svcOf(applyFormChanges(edited, base, next), "app").environment).toEqual({ MODE: "green", FEATURE: "on" });
  });

  test("a service deleted in the YAML is not written back from the stale form", () => {
    const base   = snapshot(CASAOS);
    const edited = CASAOS.replace("  db:\n    image: postgres:16\n    environment:\n    - POSTGRES_PASSWORD=secret\n    restart: always\n", "");
    const next   = editService(base, "jellyfin", f => ({ ...f, imageTag: "10.9.0" }));
    const out    = applyFormChanges(edited, base, next);
    expect(Object.keys((parse(out) as ParsedCompose).services)).toEqual(["jellyfin"]);
  });
});

describe("applyFormChanges — anchors and aliases", () => {
  const yaml = "x-w: &w\n  image: busybox\n  hostname: w\nservices:\n  web:\n    image: nginx\n  worker: *w\n";

  test("an aliased service is left alone when another service is edited", () => {
    const base = snapshot(yaml);
    const next = editService(base, "web", f => ({ ...f, imageTag: "2" }));
    expect(applyFormChanges(yaml, base, next)).toBe(yaml.replace("image: nginx", "image: nginx:2"));
  });

  test("editing an aliased service edits a copy and keeps the shared anchor", () => {
    const base = snapshot(yaml);
    const next = editService(base, "worker", f => ({ ...f, imageTag: "1.36" }));
    const out  = parse(applyFormChanges(yaml, base, next)) as ParsedCompose & { "x-w": unknown };
    expect(out.services.worker).toEqual({ image: "busybox:1.36", hostname: "w" });
    expect(out["x-w"]).toEqual({ image: "busybox", hostname: "w" });
  });
});

describe("applyFormChanges — fields compose would reject or misread", () => {
  test("map-form extra_hosts never gets a host twice", () => {
    const yaml = "services:\n  app:\n    image: nginx\n    extra_hosts:\n      dev: \"192.0.2.1\"\n";
    const base = snapshot(yaml);
    const next = editService(base, "app", f => ({ ...f, extraHosts: [...f.extraHosts, "dev=192.0.2.2"] }));
    expect(svcOf(applyFormChanges(yaml, base, next), "app").extra_hosts).toEqual({ dev: "192.0.2.2" });
  });

  test("switching a network to external keeps only its name", () => {
    const yaml = "services:\n  app:\n    image: nginx\nnetworks:\n  lan:\n    name: shared\n    driver: bridge\n    internal: true\n";
    const base = snapshot(yaml);
    const next = { ...base, stackConfig: { ...base.stackConfig, networks: [{ ...base.stackConfig.networks[0]!, external: true }] } };
    expect((parse(applyFormChanges(yaml, base, next)) as ParsedCompose).networks).toEqual({ lan: { name: "shared", external: true } });
  });

  test("a dependency replaced by another does not inherit its condition", () => {
    const yaml = "services:\n  web:\n    image: nginx\n    depends_on:\n      db:\n        condition: service_healthy\n";
    const base = snapshot(yaml);
    const next = editService(base, "web", f => ({ ...f, dependsOn: ["cache"] }));
    expect(svcOf(applyFormChanges(yaml, base, next), "web").depends_on).toEqual({ cache: { condition: "service_started" } });
  });

  test("a port edit keeps a protocol the form cannot show", () => {
    const yaml = "services:\n  dns:\n    image: coredns\n    ports:\n      - 53:53/${PROTO:-udp}\n      - target: 54\n        published: 54\n        protocol: ${PROTO:-udp}\n";
    const base = snapshot(yaml);
    const next = editService(base, "dns", f => ({ ...f, ports: f.ports.map(p => ({ ...p, host: "1" + p.host })) }));
    expect(lineDiff(yaml, applyFormChanges(yaml, base, next))).toEqual({
      added:   ["      - 153:53/${PROTO:-udp}", "        published: 154"],
      removed: ["      - 53:53/${PROTO:-udp}", "        published: 54"],
    });
  });

  test("a volume shows ro among other options, and a mode change keeps them", () => {
    expect(parseVolumeEntry("/DATA/Media:/media:ro,z").mode).toBe("ro");
    const base = snapshot(CASAOS);
    const next = editService(base, "jellyfin", f => ({
      ...f, volumes: f.volumes.map(v => v.container === "/media" ? { ...v, mode: "rw" as const } : v),
    }));
    expect(lineDiff(CASAOS, applyFormChanges(CASAOS, base, next)))
      .toEqual({ added: ["    - /DATA/Media:/media:rw,z"], removed: ["    - /DATA/Media:/media:ro,z"] });
  });

  test("a read-only anonymous volume is written in long syntax", () => {
    const yaml = "services:\n  app:\n    image: nginx\n    volumes:\n      - /cache\n";
    const base = snapshot(yaml);
    const next = editService(base, "app", f => ({ ...f, volumes: [{ ...f.volumes[0]!, mode: "ro" }] }));
    expect(svcOf(applyFormChanges(yaml, base, next), "app").volumes).toEqual([{ type: "volume", target: "/cache", read_only: true }]);
  });

  test("a volume row with no container path writes nothing", () => {
    const yaml = "services:\n  app:\n    image: nginx\n";
    const base = snapshot(yaml);
    const next = editService(base, "app", f => ({ ...f, volumes: [{ host: "./data", container: "", mode: "" }] }));
    expect(applyFormChanges(yaml, base, next)).toBe(yaml);
  });

  test("a number edited to a string with leading zeros keeps what was typed", () => {
    const yaml = "services:\n  app:\n    image: nginx\n    environment:\n      UMASK: 22\n";
    const base = snapshot(yaml);
    const next = editService(base, "app", f => ({ ...f, environment: [{ key: "UMASK", value: "022" }] }));
    expect(svcOf(applyFormChanges(yaml, base, next), "app").environment).toEqual({ UMASK: "022" });
  });

  test("a CRLF file keeps CRLF on the edited line", () => {
    const yaml = "services:\r\n  app:\r\n    image: nginx:1 # pinned\r\n    restart: always\r\n";
    const base = snapshot(yaml);
    const next = editService(base, "app", f => ({ ...f, imageTag: "2" }));
    expect(applyFormChanges(yaml, base, next)).toBe(yaml.replace("nginx:1", "nginx:2"));
  });
});
