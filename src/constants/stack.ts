/**
 * A stack name: letters, digits, `_` and `-`, nothing else.
 *
 * It becomes a folder under the compose folder and a Docker Compose project name, so no
 * separators and no dots: `..` would name the compose folder's parent, and Compose rejects
 * dotted project names anyway. Every route that takes a stack name uses this one rule — the
 * CasaOS migration once had its own, which allowed dots and so let `..` through.
 */
export const STACK_NAME_RE = /^[a-zA-Z0-9_-]+$/;

/**
 * A name a new stack may take: what Docker Compose accepts as a project name. Lowercase
 * letters, digits, `_` and `-`, starting with a letter or digit.
 *
 * Stricter than {@link STACK_NAME_RE}, which every route uses to find a stack that already
 * exists. Every Compose command runs with `-p <stack>`, and Compose refuses `-p Photos`, so
 * an install named that would pass the route's checks and then fail at its first command.
 */
export const PROJECT_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;
