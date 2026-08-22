# Plan — follow-up fixes after PR #31

Deliberately kept out of PR #31: that branch is the update checker, it is one round away
from a clean review, and adding fresh code restarts the convergence. Everything here lands
on a branch off `main` **after** #31 merges.

Ordered by independence — each item can ship alone.

---

## 1. Image count reads the wrong number

**Where:** `DockerClient.getSummary()` in `src/lib/docker.ts`, surfaced by the dashboard
summary bar.

**What's wrong:** the count comes from `/info`'s `Images` field, which counts image
*records*. Measured on this host:

```
/info Images        192   ← what the bar shows
docker images       132   ← one row per tag
unique image IDs    111   ← what a person means by "images"
docker system df    113
```

Portainer reports 117, in the same family as the lower figures. The gap is not dangling
images — there are only **2** of those. It is `/info`'s accounting plus one row per tag.

**Fix:** count distinct `Id` values from `/images/json`. One extra daemon call, already
made alongside the others in `getSummary()`, so no extra round trip in practice.

**Test:** unique-ID counting over a fixture with the same image under two tags.

---

## 2. `/copy` and `/move` never kill their subprocess

**Where:** `src/plugins/routeFiles.ts`, the two SSE endpoints behind copy/paste in the
file browser.

**What's wrong:** neither registers an abort listener. Close the tab mid-copy and `rsync`
keeps running with nothing consuming its output; once the aggregator's buffer fills, the
producers suspend and the subprocess is never reaped. This is exactly the leak CodeRabbit
found in `routeCompose` during the compose-repair work, in a place we noticed at the time
and deliberately left alone as out of scope.

**Fix:** the pattern already used by `/convert` and `routeCompose`:

```ts
request.signal.addEventListener("abort", () => { proc.kill(); agg.end(); }, { once: true });
```

`/move` needs care — its cross-device path spawns several processes in sequence, so the
listener must kill whichever is current, as `convert-folder` does.

**Note:** the `sse.ts` deadlock fix in v0.9.0 removed the *permanent* hang, so this is now
a leak rather than a wedge. Still worth fixing.

---

## 3. Offer to delete bind paths when removing a stack

The substantial one. Full design in [PLAN_disk_cleanup.md](PLAN_disk_cleanup.md) — summary
here so this file stands alone.

**Where it stands:** `GET /api/docker/stacks/:name/binds` already resolves a stack's
bind-mounted host paths and skips infrastructure mounts. The delete dialog already lists
them under *"Host paths — will remain on disk"*. Discovery is done; only acting on it is
missing, and `routeDocker` documents the omission as intentional.

**Why change it:** removing a stack silently leaves gigabytes in `/DATA/AppData/<app>`,
and the only hint vanishes with the dialog.

**Shape:** per-path checkboxes, **all unchecked by default**, each showing its size;
deletion after the containers are gone, streamed over the existing SSE channel.

**Guards — the bulk of the work:**
- Refuse `/`, `/DATA`, `/DATA/AppData`, home directories, or any path fewer than two
  segments below the files root
- Refuse paths outside `config.filesRoot`
- Refuse paths **shared with another stack** — `/DATA/AppData` is a common parent and
  deleting a sibling's data is unrecoverable; cross-check every other project's binds
- Re-resolve server-side and re-read the binds from Docker; the client's list is a
  request, not an authority, and may be minutes stale

**Principle carried over from the compose repair work:** when an operation can destroy
something the user did not explicitly name, it refuses and explains rather than proceeding.

---

## 4. Docker resource cleanup panel

Separate PR of its own — see [PLAN_disk_cleanup.md](PLAN_disk_cleanup.md) Feature B.

Kept apart because volume pruning deserves its own review pass: **204 of the 206 volumes**
on this host are "unused", and most of those are stopped stacks' databases, not garbage.
"Unused" means *not currently referenced*, which is not *not wanted*.

Start with the two low-risk, high-yield categories — dangling images and build cache,
about **37 GB** here — and add volumes and unused-images only once the confirm patterns
from item 3 are proven.

---

## Sequencing

| | item | size | risk |
|---|---|---|---|
| 1 | Image count | small | none |
| 2 | Copy/move abort | small | none |
| 3 | Bind paths on delete | medium | high — deletes user data |
| 4 | Cleanup panel | large | high — deletes user data |

Items 1 and 2 can share one branch and one review. Items 3 and 4 each want their own,
because both destroy things that cannot be recreated from a compose file.

## Still open, not yet planned

- **CodeRabbit CLI seat** — unlinked, so it falls back to 3 free reviews and stalls for
  ~30 minutes at a time. Not a code issue; noted because it has shaped the whole review
  cadence today. User's call, likely a free-tier constraint.
