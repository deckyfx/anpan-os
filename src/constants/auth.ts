import { t } from "elysia";

export const USERNAME_MIN = 3;
export const USERNAME_MAX = 32;
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 32;

// ─── TypeBox schemas — type contract only, not business rules ─────────────────

/** Asserts the value is a string. Business constraints are validated in the handler. */
export const usernameField = t.String();
export const passwordField = t.String();

// ─── Runtime constraint validators ───────────────────────────────────────────

const USERNAME_PATTERN = /^[a-zA-Z0-9_.-]+$/;
const PASSWORD_PATTERN = /^[\x21-\x7E]+$/; // printable ASCII, no spaces

/** Returns an error string if username fails constraints, otherwise null. */
export function validateUsername(value: string): string | null {
  if (value.length < USERNAME_MIN || value.length > USERNAME_MAX)
    return `Username must be ${USERNAME_MIN}–${USERNAME_MAX} characters`;
  if (!USERNAME_PATTERN.test(value))
    return "Username may only contain letters, numbers, _, ., or -";
  return null;
}

/** Returns an error string if password fails constraints, otherwise null. */
export function validatePassword(value: string): string | null {
  if (value.length < PASSWORD_MIN || value.length > PASSWORD_MAX)
    return `Password must be ${PASSWORD_MIN}–${PASSWORD_MAX} characters`;
  if (!PASSWORD_PATTERN.test(value))
    return "Password must not contain spaces";
  return null;
}
