import { test, expect, beforeAll } from "bun:test";
import { createTestClient } from "./helpers";

const client = createTestClient();

beforeAll(async () => {
  await client.api.auth.setup.post({ username: "admin", password: "password123" });
});

// test.failing asserts that this body DOES fail. The canary still proves the suite
// notices a broken assertion, but a healthy repository now reports zero failures, so a
// genuine regression stands out instead of hiding among expected red.
test.failing("wrong password → expects 200 (intentionally wrong assertion)", async () => {
  const { response } = await client.api.auth.login.post({
    username: "admin",
    password: "WRONGPASSWORD",
  });
  expect(response.status).toBe(200); // should FAIL — real server returns 401
});
