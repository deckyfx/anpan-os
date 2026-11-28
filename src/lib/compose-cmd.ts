import { join } from "node:path";

/** The compose file anpan-os writes, and the one it reads from CasaOS's folders too. */
export const COMPOSE_FILE = "docker-compose.yml";

/**
 * The start of every Compose command for a stack: `docker compose -p <stack> -f <dir>/docker-compose.yml`.
 *
 * Both are given so that every command, whoever runs it, targets the same project and the
 * same file:
 * - Without `-p`, Compose takes the project from `COMPOSE_PROJECT_NAME` in `.env` or a
 *   top-level `name:`. A dashboard "down" could then stop a different project from the one
 *   an install started.
 * - Without `-f`, Compose picks `compose.yaml` over `docker-compose.yml` when both exist.
 *   A migration could then check one file and start the other.
 *
 * The `.env` Compose reads is still `<dir>/.env`, since it looks in the first file's folder.
 */
export function composeCommand(docker: string, stack: string, dir: string): string[] {
  return [docker, "compose", "-p", stack, "-f", join(dir, COMPOSE_FILE)];
}
