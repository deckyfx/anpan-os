import { describe, test, expect } from "bun:test";
import { API_KEY_RULES, keyMayAccess, normaliseKeyPath } from "../src/lib/api-key-scope";

/**
 * The scope policy as a matrix. Each row is one request and what each scope must answer,
 * so a change to the rule table shows up here as a row that flipped, not as a vague failure.
 */

type Row = [method: string, path: string, read: boolean, operate: boolean, full: boolean];

const MATRIX: Row[] = [
  // Reads anyone may make.
  ["GET",    "/api/me",                                  true,  true,  true ],
  ["GET",    "/api/system/stats",                        true,  true,  true ],
  ["HEAD",   "/api/system/info",                         true,  true,  true ],
  ["GET",    "/api/docker/stacks",                       true,  true,  true ],
  ["GET",    "/api/docker/update-check/report",          true,  true,  true ],
  ["GET",    "/api/compose/stacks/web/logs",             true,  true,  true ],
  ["GET",    "/api/samba/shares",                        true,  true,  true ],
  ["GET",    "/api/casaos/apps",                         true,  true,  true ],
  ["GET",    "/api/ports",                               true,  true,  true ],
  ["GET",    "/api/bookmarks",                           true,  true,  true ],
  ["GET",    "/api/app-store/repos",                     true,  true,  true ],
  ["GET",    "/api/openapi.json",                        true,  true,  true ],

  // File reads are full-only: files.root can be /.
  ["GET",    "/api/files/read",                          false, false, true ],
  ["GET",    "/api/files/download",                      false, false, true ],
  ["GET",    "/api/files",                               false, false, true ],
  ["PUT",    "/api/files/write",                         false, false, true ],

  // Operate: running the apps.
  ["POST",   "/api/docker/containers/abc/restart",       false, true,  true ],
  ["POST",   "/api/docker/stacks/web/forget",            false, true,  true ],
  ["PATCH",  "/api/docker/stacks/web",                   false, true,  true ],
  ["POST",   "/api/docker/update-check/start",           false, true,  true ],
  ["DELETE", "/api/docker/update-check",                 false, true,  true ],
  ["POST",   "/api/compose/stacks",                      false, true,  true ],
  ["POST",   "/api/compose/stacks/web/pull",             false, true,  true ],
  ["PUT",    "/api/compose/stacks/web/file",             false, true,  true ],
  ["POST",   "/api/app-store/repos",                     false, true,  true ],
  ["POST",   "/api/bookmarks",                           false, true,  true ],
  ["DELETE", "/api/bookmarks/3",                         false, true,  true ],
  ["PUT",    "/api/ports/notes/8080",                    false, true,  true ],

  // Destroying data is full-only even inside operate's prefixes.
  ["POST",   "/api/docker/prune",                        false, false, true ],
  ["DELETE", "/api/docker/stacks/web",                   false, false, true ],

  // The machine itself: full only.
  ["POST",   "/api/system/shutdown",                     false, false, true ],
  ["POST",   "/api/system/restart",                      false, false, true ],
  ["POST",   "/api/system/update",                       false, false, true ],
  ["POST",   "/api/samba/shares",                        false, false, true ],
  ["POST",   "/api/casaos/import/x",                     false, false, true ],
  ["GET",    "/api/docker/disk-usage",                   true,  true,  true ],

  // Never, with any key.
  ["GET",    "/api/api-keys",                            false, false, false],
  ["POST",   "/api/api-keys",                            false, false, false],
  ["DELETE", "/api/api-keys/0123456789ab",               false, false, false],
  ["GET",    "/api/backups",                             false, false, false],
  ["GET",    "/api/backups/20261128-093000/download",    false, false, false],
  ["POST",   "/api/backups/20261128-093000/restore",     false, false, false],
  ["GET",    "/api/auth/status",                         false, false, false],
  ["PUT",    "/api/auth/password",                       false, false, false],
  ["POST",   "/api/auth/passkey/register-options",       false, false, false],
  ["GET",    "/api/auth/passkey/credentials",            false, false, false],

  // A prefix nobody has classified yet is full-only.
  ["GET",    "/api/widgets",                             false, false, true ],
  ["POST",   "/api/widgets/1",                           false, false, true ],

  // Outside /api the guard never runs; nothing is granted there.
  ["GET",    "/",                                        false, false, false],
  ["GET",    "/settings",                                false, false, false],

  // Methods no rule names are writes as far as read is concerned.
  ["OPTIONS", "/api/me",                                 false, false, true ],
];

describe("keyMayAccess — scope × method × path", () => {
  for (const [method, path, read, operate, full] of MATRIX) {
    test(`${method} ${path}`, () => {
      expect({
        read:    keyMayAccess("read",    method, path),
        operate: keyMayAccess("operate", method, path),
        full:    keyMayAccess("full",    method, path),
      }).toEqual({ read, operate, full });
    });
  }
});

describe("keyMayAccess — path tricks", () => {
  test("`..` cannot climb out of a granted prefix", () => {
    expect(keyMayAccess("read", "GET", "/api/docker/../files/read")).toBe(false);
    expect(keyMayAccess("operate", "POST", "/api/bookmarks/../docker/prune")).toBe(false);
    // Refused outright, not resolved — even where the resolved path would be allowed.
    expect(keyMayAccess("full", "GET", "/api/docker/../system/info")).toBe(false);
  });

  test("percent-encoded dots and slashes are refused too", () => {
    expect(keyMayAccess("read", "GET", "/api/docker/%2e%2e/files/read")).toBe(false);
    expect(keyMayAccess("read", "GET", "/api/docker/%2E%2E/files/read")).toBe(false);
    expect(keyMayAccess("operate", "POST", "/api/bookmarks%2f..%2fdocker/prune")).toBe(false);
    expect(keyMayAccess("read", "GET", "/api/docker/.")).toBe(false);
  });

  test("an encoded or differently-cased name is judged as the name it spells", () => {
    expect(keyMayAccess("read", "GET", "/api/%66iles/read")).toBe(false);
    expect(keyMayAccess("read", "GET", "/API/Files/read")).toBe(false);
    expect(keyMayAccess("full", "GET", "/API/API-KEYS")).toBe(false);
    expect(keyMayAccess("full", "GET", "/api/%61uth/status")).toBe(false);
  });

  test("prefixes match whole segments only", () => {
    expect(keyMayAccess("read", "GET", "/api/dockerx")).toBe(false);
    expect(keyMayAccess("read", "GET", "/api/docker-files")).toBe(false);
    expect(keyMayAccess("read", "GET", "/api/meow")).toBe(false);
    // Not prune — but not under any operate grant either, so still refused.
    expect(keyMayAccess("operate", "POST", "/api/docker/pruned")).toBe(false);
    expect(keyMayAccess("operate", "POST", "/api/docker/containersx/a")).toBe(false);
    expect(keyMayAccess("operate", "POST", "/api/docker/stacksx/a")).toBe(false);
    // /api/api-keysx is not key management, so it falls to the full-only catch-all.
    expect(keyMayAccess("full", "GET", "/api/api-keysx")).toBe(true);
    expect(keyMayAccess("full", "GET", "/api/authority")).toBe(true);
  });

  test("query, fragment, trailing and doubled slashes do not change the answer", () => {
    expect(keyMayAccess("read", "GET", "/api/files/read?path=/etc/shadow")).toBe(false);
    expect(keyMayAccess("read", "GET", "/api/system/stats?x=1")).toBe(true);
    expect(keyMayAccess("read", "GET", "/api/system/stats/")).toBe(true);
    expect(keyMayAccess("read", "GET", "//api//files//read")).toBe(false);
    expect(keyMayAccess("operate", "POST", "/api/docker//prune/")).toBe(false);
    expect(keyMayAccess("full", "GET", "/api//api-keys")).toBe(false);
    expect(keyMayAccess("full", "GET", "/api/auth/?x")).toBe(false);
  });

  test("method case does not matter", () => {
    expect(keyMayAccess("read", "get", "/api/me")).toBe(true);
    expect(keyMayAccess("read", "post", "/api/bookmarks")).toBe(false);
  });

  test("an unknown scope is refused everything", () => {
    expect(keyMayAccess("admin", "GET", "/api/me")).toBe(false);
    expect(keyMayAccess("", "GET", "/api/me")).toBe(false);
  });
});

describe("normaliseKeyPath", () => {
  test("canonical form", () => {
    expect(normaliseKeyPath("/api//Docker/stacks/?q=1#f")).toBe("/api/docker/stacks");
    expect(normaliseKeyPath("/")).toBe("/");
    expect(normaliseKeyPath("")).toBe("/");
  });

  test("refuses what it cannot judge", () => {
    expect(normaliseKeyPath("/api/../x")).toBeNull();
    expect(normaliseKeyPath("/api/%2fx")).toBeNull();
    expect(normaliseKeyPath("/api/%5cx")).toBeNull();
    expect(normaliseKeyPath("/api/%E0%A4%A")).toBeNull();   // malformed escape
  });
});

describe("API_KEY_RULES", () => {
  test("every line explains itself", () => {
    for (const rule of API_KEY_RULES) expect(rule.reason.length).toBeGreaterThan(20);
  });

  test("ends with the full-only catch-all, so anything unlisted needs full", () => {
    const last = API_KEY_RULES.at(-1);
    expect(last).toMatchObject({ prefix: "/api", methods: "*", minScope: "full" });
  });
});
