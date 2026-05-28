import { Elysia, t, sse } from "elysia";
import { authGuard } from "./authGuard";
import { AppRepoStore } from "../stores/app-repo-store";
import {
  fetchRemoteCasaOSApps,
  fetchRemoteComposeContent,
  parseGithubUrl,
  FetchResponseError,
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
        // Normalise to a single canonical form so equivalent URLs hit the UNIQUE constraint.
        let canonicalUrl: string;
        try {
          const { owner, repo } = parseGithubUrl(body.url);
          canonicalUrl = `https://github.com/${owner.toLowerCase()}/${repo.toLowerCase()}`;
        } catch {
          set.status = 400;
          return { error: "URL must be a valid github.com repository URL" };
        }
        try {
          const repo = await AppRepoStore.create({ name: body.name, url: canonicalUrl });
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

    // ── Apps (streamed from all enabled repos as each resolves) ─────────────

    .get("/apps", async function*() {
      const repos = await AppRepoStore.findAll();
      const enabled = repos.filter(r => r.enabled);

      if (enabled.length === 0) {
        yield sse({ data: { apps: [] as RemoteCasaOSApp[], errors: [] as string[], done: true } });
        return;
      }

      type RepoResult =
        | { ok: true; apps: RemoteCasaOSApp[] }
        | { ok: false; error: string };

      // Kick off all repo fetches concurrently
      let remaining: Promise<RepoResult>[] = enabled.map(r =>
        getAppsForRepo(r.id, r.url)
          .then(apps => ({ ok: true as const, apps }))
          .catch(e => ({ ok: false as const, error: `${r.name}: ${e instanceof Error ? e.message : String(e)}` })),
      );

      // Stream each repo's result as it completes (completion order, not original order)
      while (remaining.length > 0) {
        const tagged = remaining.map((p, i) => p.then(v => ({ v, i })));
        const { v, i } = await Promise.race(tagged);
        remaining.splice(i, 1);

        yield sse({
          data: {
            apps:   v.ok ? v.apps : ([] as RemoteCasaOSApp[]),
            errors: v.ok ? [] : [v.error],
            done:   remaining.length === 0,
          },
        });
      }
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
          } catch (e) {
            // Only continue to the next branch on a true 404; anything else (timeout, 5xx) is upstream failure.
            if (e instanceof FetchResponseError && e.status === 404) continue;
            set.status = 502;
            return { error: e instanceof Error ? e.message : String(e) };
          }
        }
        set.status = 404;
        return { error: "Compose file not found" };
      },
      { params: t.Object({ repoId: t.String(), appName: t.String() }) },
    );
}
