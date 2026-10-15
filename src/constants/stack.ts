/**
 * A stack name: letters, digits, `_` and `-`, nothing else.
 *
 * It becomes a folder under the compose folder and a Docker Compose project name, so no
 * separators and no dots: `..` would name the compose folder's parent, and Compose rejects
 * dotted project names anyway. Every route that takes a stack name uses this one rule — the
 * CasaOS migration once had its own, which allowed dots and so let `..` through.
 */
export const STACK_NAME_RE = /^[a-zA-Z0-9_-]+$/;
