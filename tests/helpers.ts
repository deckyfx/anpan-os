import { treaty } from "@elysiajs/eden";
import { createApp } from "../src/app";

export const TEST_JWT = "test-jwt-secret-for-anpan-os";

/** Create a treaty client backed by a fresh in-process Elysia app — no server or port needed. */
export function createTestClient() {
  const app = createApp(TEST_JWT);
  return treaty(app);
}

/** Extract the anpan_session cookie and raw JWT from a Set-Cookie header. */
export function extractCookie(res: Response): { cookie: string; jwt: string } {
  const raw   = res.headers.get("set-cookie") ?? "";
  const match = raw.match(/anpan_session=([^;]+)/);
  if (!match?.[1]) throw new Error(`No anpan_session in Set-Cookie: ${raw}`);
  return { cookie: `anpan_session=${match[1]}`, jwt: match[1] };
}

/** Extract the `error` string from an Eden Treaty error response value. */
export function errMsg(value: unknown): string {
  return (value as { error?: string })?.error ?? "(no message)";
}

/**
 * Ensure an admin account exists and return a valid session cookie.
 * Safe to call multiple times — setup returns 403 if admin already exists.
 */
export async function loginAs(
  username = "admin",
  password = "password123",
): Promise<string> {
  const client = createTestClient();

  // Create admin if not yet initialized (ignore 403 — already exists)
  await client.api.auth.setup.post({ username, password });

  const { response } = await client.api.auth.login.post({ username, password });
  const { cookie } = extractCookie(response);
  return cookie;
}
