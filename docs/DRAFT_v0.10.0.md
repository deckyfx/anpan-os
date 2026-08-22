# Draft — v0.10.0 release notes

> Draft only. Not committed to ROADMAP.md until PR #31 merges clean.
> Version bump: `package.json` 0.9.0 → 0.10.0.

## The bug this release fixes

The Docker image update checker reported **no updates at all** — and would have been
wrong if it had ever finished. Two independent faults, both measured on a real host:

- **Too slow to complete.** `docker manifest inspect --verbose` takes 18–49 s per image,
  so a 46-image sweep never reached the end before the SSE stream died.
- **Comparing incomparable digests.** It read a *per-platform manifest* digest and
  compared it against the *index* digest Docker records locally. For any multi-arch image
  those can never be equal, so a completed sweep would have flagged everything as
  outdated.

Replaced with the registry HTTP API — token via `WWW-Authenticate` discovery, then `HEAD`
the manifest and read `Docker-Content-Digest`, which is the index digest and therefore
comparable. **45 images now take 8 seconds.**

`HEAD` is deliberate: Docker Hub charges a manifest `GET` against the pull limit but not a
`HEAD` (measured — remaining held at 100 across repeated HEADs, dropped by one on a GET),
so a full sweep costs nothing against the quota. The `GET` fallback for registries that
reject `HEAD` is counted and surfaced, because that path does cost budget.

## The checker is now a background job

The sweep used to belong to an HTTP request, so closing the tab cancelled it. It now
belongs to the server: results are written to SQLite as each lands, routes only subscribe,
and a reload shows real progress.

- **Single-flight**, with an atomic force-restart that cancels and replaces in one step
- **Opportunistic scheduling** — the dashboard asks on mount and the *server* decides,
  gated on staleness, so several tabs cannot each trigger work
- **Per-stack checks** from the stack tile menu
- **Anti-stall** — 20 s per image, a 10-minute run watchdog, and runs left `running` by a
  killed process marked interrupted on boot
- **Private registries** reuse `~/.docker/config.json`; credentials travel only to the
  registry's own host over HTTPS

## New in the UI

- **Updates menu** — Check all / View report / Cancel, with live `12/45` progress
- **Report dialog** showing what a bare badge could not: skipped digest-pinned images,
  registries that refused, and how long each update has been waiting
- **Purge** for stored results, refused server-side with 409 while a check runs

## Security fixes

Found during review, and both predate this work — they arrived with the launch-URL code:

- **`javascript:` URLs could reach the dashboard.** `scheme` was taken verbatim from stack
  metadata, which is user-editable and also populated by CasaOS imports, and the result is
  used as an anchor `href`. Restricted to http/https.
- **Addresses could smuggle a different host.** `good.com@evil.com` built
  `http://good.com@evil.com/`, which browsers resolve to **evil.com** — a tile that looks
  trusted and navigates elsewhere. Authorities containing `@ / ? #` are now rejected, as
  are malformed IPv6 literals and out-of-range ports.

## Also

- Show/hide dotfiles in the file browser
- Toasts moved below the top bar; a raw `alert()` replaced with a proper toast
- **TypeScript 7.0.2**
- Test suite **58 pass / 6 fail → 135 pass / 0 fail**

### Notes

The six long-standing test failures were three different situations: one intentional
canary (now `test.failing`), two stale tests written against a `diskUsed`/`diskTotal` API
that had moved to per-mount `disks[]`, and three that were **right all along** — compose
name validation lived inside an SSE generator, so a rejected name returned `200 OK` with
an error event in the body. A browser coped; a script would have read it as success.
