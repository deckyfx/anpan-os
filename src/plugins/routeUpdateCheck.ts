import { Elysia, sse } from "elysia";
import { authGuard } from "./authGuard";
import { bins } from "../lib/commands";

// ─── SSE message types ────────────────────────────────────────────────────────

export interface UpdateCheckMsg {
  /** Image being inspected right now. */
  checking?: { stack: string; image: string };
  /** Result for one image. */
  result?: { stack: string; image: string; hasUpdate: boolean };
  /** Final summary once all images are processed. */
  done?: { found: number };
  error?: string;
}

// ─── Module-level abort controller — only one check runs at a time ────────────

let globalAbort = new AbortController();

// ─── Helpers ─────────────────────────────────────────────────────────────────

interface ImageCheck {
  stack: string;
  image: string;
}

/** Returns all unique (stack, image) pairs from running+stopped compose containers. */
async function getComposeImages(docker: string): Promise<ImageCheck[]> {
  const proc = Bun.spawn([docker, "ps", "-a", "--format", "{{json .}}"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const output = await new Response(proc.stdout).text();
  await proc.exited;

  const seen = new Set<string>();
  const checks: ImageCheck[] = [];

  for (const line of output.trim().split("\n")) {
    if (!line.trim()) continue;
    try {
      const c = JSON.parse(line) as {
        Labels: string | Record<string, string> | null;
        Image: string;
      };
      // Labels may be a comma-separated "k=v,k=v" string or an object
      let stack = "";
      if (typeof c.Labels === "string") {
        const m = c.Labels.match(/com\.docker\.compose\.project=([^,]+)/);
        stack = m?.[1]?.trim() ?? "";
      } else if (c.Labels && typeof c.Labels === "object") {
        stack = c.Labels["com.docker.compose.project"]?.trim() ?? "";
      }
      const image = c.Image?.trim() ?? "";
      if (!stack || !image) continue;
      // Skip images referenced by digest only (sha256:...) — can't check updates
      if (image.startsWith("sha256:")) continue;

      const key = `${stack}::${image}`;
      if (!seen.has(key)) {
        seen.add(key);
        checks.push({ stack, image });
      }
    } catch {
      // malformed line — skip
    }
  }
  return checks;
}

/** Local digest for the image, e.g. "sha256:abc…". Returns null if unavailable. */
async function getLocalDigest(docker: string, image: string): Promise<string | null> {
  const proc = Bun.spawn(
    [docker, "image", "inspect", image, "--format", "{{index .RepoDigests 0}}"],
    { stdout: "pipe", stderr: "ignore" },
  );
  const out = (await new Response(proc.stdout).text()).trim();
  await proc.exited;
  // format: "nginx@sha256:abc" → "sha256:abc"
  const at = out.indexOf("@");
  return at >= 0 ? out.slice(at + 1) : null;
}

/**
 * Remote manifest digest via `docker manifest inspect --verbose`.
 * Returns null if the command fails (e.g. auth required, network error).
 */
async function getRemoteDigest(docker: string, image: string): Promise<string | null> {
  const proc = Bun.spawn([docker, "manifest", "inspect", "--verbose", image], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const out = (await new Response(proc.stdout).text()).trim();
  await proc.exited;
  if (!out) return null;
  try {
    const json = JSON.parse(out) as unknown;
    // Single manifest
    if (json && typeof json === "object" && !Array.isArray(json)) {
      const j = json as Record<string, unknown>;
      const desc = j["Descriptor"] as Record<string, unknown> | undefined;
      return (desc?.["digest"] as string) ?? null;
    }
    // Multi-arch manifest list → use first entry
    if (Array.isArray(json) && json.length > 0) {
      const first = json[0] as Record<string, unknown>;
      const desc = first["Descriptor"] as Record<string, unknown> | undefined;
      return (desc?.["digest"] as string) ?? null;
    }
  } catch {
    // parse failed
  }
  return null;
}

// ─── Route ───────────────────────────────────────────────────────────────────

export function updateCheckPlugin(jwtSecret: string) {
  return new Elysia({ prefix: "/api/docker" })
    .use(authGuard(jwtSecret))
    /**
     * GET /api/docker/update-check
     *
     * SSE stream that checks all compose containers for image updates.
     * Any in-progress check is cancelled when a new request arrives.
     *
     * Message shapes: UpdateCheckMsg (see type above).
     */
    .get("/update-check", async function* () {
      // Cancel any previous check
      globalAbort.abort();
      globalAbort = new AbortController();
      const { signal } = globalAbort;

      const docker = bins.docker;
      if (!docker) {
        yield sse({ data: { error: "Docker is not available on this system" } satisfies UpdateCheckMsg });
        return;
      }

      const checks = await getComposeImages(docker);
      if (checks.length === 0) {
        yield sse({ data: { done: { found: 0 } } satisfies UpdateCheckMsg });
        return;
      }

      let found = 0;

      for (const { stack, image } of checks) {
        if (signal.aborted) return;

        yield sse({ data: { checking: { stack, image } } satisfies UpdateCheckMsg });

        // Run both fetches concurrently; abort-race so we don't hang forever
        const abortPromise = new Promise<null>(resolve =>
          signal.addEventListener("abort", () => resolve(null), { once: true }),
        );

        const checkResult = await Promise.race([
          Promise.all([
            getLocalDigest(docker, image),
            getRemoteDigest(docker, image),
          ]).then(([local, remote]) => ({ local, remote })),
          abortPromise,
        ]);

        if (!checkResult || signal.aborted) return;

        const { local, remote } = checkResult;
        // If we can't get either digest, we report no update rather than false-positive
        const hasUpdate = !!(local && remote && local !== remote);
        if (hasUpdate) found++;

        yield sse({ data: { result: { stack, image, hasUpdate } } satisfies UpdateCheckMsg });
      }

      if (!signal.aborted) {
        yield sse({ data: { done: { found } } satisfies UpdateCheckMsg });
      }
    });
}
