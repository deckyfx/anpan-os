/**
 * SQL files imported as text.
 *
 * Bun resolves `with { type: "text" }` and compiles the contents into the bundle, but
 * TypeScript has no built-in knowledge of the extension. Declaring it here lets the
 * migration manifest import drizzle/*.sql directly, so the SQL lives in exactly one place
 * rather than being copied into a generated module.
 */
declare module "*.sql" {
  const content: string;
  export default content;
}
