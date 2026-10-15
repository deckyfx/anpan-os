import { test, expect, describe, beforeAll } from "bun:test";
import { createApp } from "../src/app";
import { TEST_JWT, loginAs } from "./helpers";

/**
 * The migrate route streams its progress as SSE. These pin down how it refuses bad input:
 * always as an error event on the stream, never as a crash. Whether the run would then
 * succeed depends on root and Docker, which tests do not assume — so they assert only on
 * the refusals, which come before either.
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

describe("CasaOS migrate", () => {
  test("a request with no body is answered on the stream, not with a crash", async () => {
    // Reading `composePath` through an omitted body threw before the default path was chosen.
    const { status, stream } = await migrate("some-app");
    expect(status).toBe(200);
    expect(stream).toContain('"error"');
    expect(stream).not.toContain("undefined is not an object");
  });
});
