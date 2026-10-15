import { test, expect, describe, beforeAll } from "bun:test";
import { createApp } from "../src/app";
import { FEATURES } from "../src/lib/platform";
import { TEST_JWT, loginAs } from "./helpers";

/**
 * The migrate route streams its progress as SSE. These pin down how it refuses bad input:
 * always as an error event on the stream, never as a crash. Whether the run would then
 * succeed depends on root and Docker, which tests do not assume — so they assert only on
 * the refusals, which come before either.
 *
 * CasaOS exists only on Linux, and elsewhere the plugin answers 501 before anything else —
 * so the route's own behaviour is tested where it is enabled, and the 501 where it is not.
 */

const app = createApp(TEST_JWT);
let cookie: string;
beforeAll(async () => { cookie = await loginAs(); });

/** POST to the migrate route and read the whole event stream. */
async function migrate(name: string, body?: unknown) {
  const res = await app.handle(new Request(`http://localhost/api/casaos/migrate/${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  return { status: res.status, stream: await res.text() };
}

describe.skipIf(!FEATURES.casaosMigration)("CasaOS migrate", () => {
  test("a request with no body is answered on the stream, not with a crash", async () => {
    // Reading `composePath` through an omitted body threw before the default path was chosen.
    const { status, stream } = await migrate("some-app");
    expect(status).toBe(200);
    expect(stream).toContain('"error"');
    expect(stream).not.toContain("undefined is not an object");
  });

  test("a dotted stack name is refused before anything is read or written", async () => {
    // The route's own pattern allowed dots. The name becomes a Compose project name, which
    // Compose rejects with a dot, and a stack folder the compose routes refuse to manage.
    const { status, stream } = await migrate("a.b", {});
    expect(status).toBe(200);
    expect(stream).toContain("Invalid stack name");
    expect(stream).not.toContain('"step"');              // refused before the first step
  });

});

describe("CasaOS migrate, on any platform", () => {
  test("a dot-segment name never reaches the route", async () => {
    // URLs collapse ".." and its encodings before routing, so the stack-folder escape a
    // ".." name would be cannot arrive this way. Pinned so that stays true.
    for (const segment of ["..", "%2e%2e", ".%2e"]) {
      const res = await app.handle(new Request(`http://localhost/api/casaos/migrate/${segment}`, {
        method: "POST", headers: { cookie },
      }));
      expect(res.status).toBe(404);
    }
  });

  test.skipIf(FEATURES.casaosMigration)("where CasaOS cannot exist, the route says so with 501", async () => {
    const { status } = await migrate("some-app", {});
    expect(status).toBe(501);
  });
});
