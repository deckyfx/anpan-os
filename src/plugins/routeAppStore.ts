import { Elysia, t } from "elysia";
import { authGuard } from "./authGuard";
import { AppRepoStore } from "../stores/app-repo-store";
import {
  fetchRemoteCasaOSApps,
  fetchRemoteComposeContent,
  parseGithubUrl,
  type RemoteCasaOSApp,
} from "../lib/casaos";

const UNSIGNED_INT = /^\d+$/;

function parseId(raw: string): number | null {
  if (!UNSIGNED_INT.test(raw)) return null;
  return parseInt(raw, 10);
}

function isGithubUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.hostname === "github.com" && u.pathname.split("/").filter(Boolean).length >= 2;
  } catch {
    return false;
  }
}

// ─── In-memory cache ──────────────────────────────────────────────────────────

interface CacheEntry { apps: RemoteCasaOSApp[]; fetchedAt: number }
const appCache = new Map<number, CacheEntry>();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

function isFresh(entry: CacheEntry): boolean {
  return Date.now() - entry.fetchedAt < CACHE_TTL_MS;
}

/** Fetch apps for a single repo, using cache when fresh. */
async function getAppsForRepo(id: number, url: string): Promise<RemoteCasaOSApp[]> {
  const cached = appCache.get(id);
  if (cached && isFresh(cached)) return cached.apps;
  const apps = await fetchRemoteCasaOSApps(id, url);
  appCache.set(id, { apps, fetchedAt: Date.now() });
  return apps;
}

// ─── Plugin ───────────────────────────────────────────────────────────────────

/** App Store plugin — repo management and remote app browsing. */
export function appStorePlugin(jwtSecret: string) {
  return new Elysia({ prefix: "/api/app-store" })
    .use(authGuard(jwtSecret))

    // ── Repos ────────────────────────────────────────────────────────────────

    .get("/repos", () => AppRepoStore.findAll())

    .post(
      "/repos",
      async ({ body, set }) => {
        if (!isGithubUrl(body.url)) {
          set.status = 400;
          return { error: "URL must be a valid github.com repository URL" };
        }
        try {
          const repo = await AppRepoStore.create({ name: body.name, url: body.url });
          set.status = 201;
          return repo;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (msg.includes("UNIQUE")) {
            set.status = 409;
            return { error: "A repository with that URL already exists" };
          }
          throw e;
        }
      },
      {
        body: t.Object({
          name: t.String({ minLength: 1 }),
          url:  t.String({ minLength: 1 }),
        }),
      },
    )

    .patch(
      "/repos/:id",
      async ({ params, body, set }) => {
        const id = parseId(params.id);
        if (id === null) { set.status = 400; return { error: "Invalid id" }; }
        if (body.name === undefined && body.enabled === undefined) {
          set.status = 400;
          return { error: "Provide at least one of: name, enabled" };
        }
        const updated = await AppRepoStore.update(id, body);
        if (!updated) { set.status = 404; return { error: "Repo not found" }; }
        return updated;
      },
      {
        params: t.Object({ id: t.String() }),
        body: t.Object({
          name:    t.Optional(t.String({ minLength: 1 })),
          enabled: t.Optional(t.Boolean()),
        }),
      },
    )

    .delete(
      "/repos/:id",
      async ({ params, set }) => {
        const id = parseId(params.id);
        if (id === null) { set.status = 400; return { error: "Invalid id" }; }
        // Evict cache on delete
        appCache.delete(id);
        const deleted = await AppRepoStore.delete(id);
        if (!deleted) { set.status = 404; return { error: "Repo not found" }; }
        return { ok: true };
      },
      { params: t.Object({ id: t.String() }) },
    )

    // ── Refresh (clear cache + re-fetch) ─────────────────────────────────────

    .post(
      "/repos/:id/refresh",
      async ({ params, set }) => {
        const id = parseId(params.id);
        if (id === null) { set.status = 400; return { error: "Invalid id" }; }
        const repo = await AppRepoStore.findById(id);
        if (!repo) { set.status = 404; return { error: "Repo not found" }; }
        appCache.delete(id);
        try {
          const apps = await fetchRemoteCasaOSApps(id, repo.url);
          appCache.set(id, { apps, fetchedAt: Date.now() });
          return { ok: true, count: apps.length };
        } catch (e) {
          set.status = 502;
          return { error: e instanceof Error ? e.message : String(e) };
        }
      },
      { params: t.Object({ id: t.String() }) },
    )

    // ── Apps (merged from all enabled repos) ─────────────────────────────────

    .get("/apps", async () => {
      const repos = await AppRepoStore.findAll();
      const enabled = repos.filter(r => r.enabled);

      const results = await Promise.allSettled(
        enabled.map(r => getAppsForRepo(r.id, r.url)),
      );

      const apps: RemoteCasaOSApp[] = [];
      const errors: string[] = [];

      for (let i = 0; i < results.length; i++) {
        const r = results[i]!;
        if (r.status === "fulfilled") {
          apps.push(...r.value);
        } else {
          errors.push(`${enabled[i]!.name}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`);
        }
      }

      return { apps, errors };
    })

    // ── Compose file for a specific app ──────────────────────────────────────

    .get(
      "/apps/:repoId/:appName/compose",
      async ({ params, set }) => {
        const repoId = parseId(params.repoId);
        if (repoId === null) { set.status = 400; return { error: "Invalid repoId" }; }

        // Try to find the app in cache first
        const cached = appCache.get(repoId);
        const app = cached?.apps.find(a => a.appName === params.appName);

        if (app) {
          try {
            const content = await fetchRemoteComposeContent(app.composeUrl);
            return { content };
          } catch (e) {
            set.status = 502;
            return { error: e instanceof Error ? e.message : String(e) };
          }
        }

        // Not cached — look up repo URL and try both common default branches.
        const repo = await AppRepoStore.findById(repoId);
        if (!repo) { set.status = 404; return { error: "Repo not found" }; }

        let parsed: { owner: string; repo: string };
        try {
          parsed = parseGithubUrl(repo.url);
        } catch {
          set.status = 400;
          return { error: "Invalid repository URL" };
        }

        const { owner, repo: repoName } = parsed;
        for (const branch of ["master", "main"]) {
          const url = `https://raw.githubusercontent.com/${owner}/${repoName}/${branch}/Apps/${encodeURIComponent(params.appName)}/docker-compose.yml`;
          try {
            const content = await fetchRemoteComposeContent(url);
            return { content };
          } catch { /* try next branch */ }
        }
        set.status = 404;
        return { error: "Compose file not found" };
      },
      { params: t.Object({ repoId: t.String(), appName: t.String() }) },
    );
}
