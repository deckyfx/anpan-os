# Plan — follow-up fixes after PR #31

PR #31 (the update checker) merged on 2026-08-22; this work followed it on
`feat/disk-cleanup-followups`.

**Status: all four items implemented.** This file is kept as the record of why each was
done the way it was — the reasoning is not obvious from the diffs, and two of the four
changed shape once they met real data.

---

## 1. Image count reads the wrong number — DONE

**Where:** `DockerClient.getSummary()` in `src/lib/docker.ts`, surfaced by the dashboard
summary bar.

**What's wrong:** the count comes from `/info`'s `Images` field, which counts image
*records*. Measured on this host:

```
/info Images        192   ← what the bar showed; includes intermediate layers
docker images       132   ← one row per tag
docker images -q    111   ← default listing, hides untagged-but-digest-referenced images
/images/json        113   ← distinct images on disk; docker system df agrees
```

Three numbers, three different questions. The gap is not dangling images — there are only
**2** of those. `/info` counts image records including intermediate layers, and `docker
images` lists one row per tag while hiding images that have a `RepoDigest` but no
`RepoTag`. Those last two are real files on disk, e.g.

```
RepoTags:    []
RepoDigests: [nginx@sha256:5a88c9c4…]
```

**Fix (implemented):** count distinct `Id` values from `/images/json` → **113**, which is
what `docker system df` reports and what a person means by "images on disk". Portainer's
117 was measured at a different moment and is not directly comparable.

---

## 2. `/copy` and `/move` never kill their subprocess — DONE

**Where:** `src/plugins/routeFiles.ts`, the two SSE endpoints behind copy/paste in the
file browser.

**What's wrong:** neither registers an abort listener. Close the tab mid-copy and `rsync`
keeps running with nothing consuming its output; once the aggregator's buffer fills, the
producers suspend and the subprocess is never reaped. This is exactly the leak CodeRabbit
found in `routeCompose` during the compose-repair work, in a place we noticed at the time
and deliberately left alone as out of scope.

**Fix (implemented):** the pattern already used by `/convert` and `routeCompose`, with two
corrections review caught — the listener must be registered *before* the first `await` and
seeded from `signal.aborted`, since one added after the client has gone never fires; and
every spawn point needs its own check, because `current` is null while `stat()` is pending
and an abort there would otherwise be followed by a process nothing can kill.

```ts
request.signal.addEventListener("abort", () => { proc.kill(); agg.end(); }, { once: true });
```

`/move` needs care — its cross-device path spawns several processes in sequence, so the
listener must kill whichever is current, as `convert-folder` does.

**Note:** the `sse.ts` deadlock fix in v0.9.0 removed the *permanent* hang, so this is now
a leak rather than a wedge. Still worth fixing.

---

## 3. Offer to delete bind paths when removing a stack — DONE

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

**Guards — the bulk of the work, and two of them came from running it against real
stacks rather than fixtures.** `/dev/shm` and `/home/decky/Music` were both judged
deletable on the first pass: a media server mounts them, but one is shared memory and the
other is a personal library the stack consumes rather than owns. The read-write flag does
not separate those from app data, since media stacks mount libraries read-write, so the
directory's identity is the signal.

- Refuse `/`, `/DATA`, `/DATA/AppData`, home directories, or any path fewer than two
  segments below the files root
- Refuse paths outside `config.filesRoot`, canonicalised with `realpath` — `guardPath()`
  is a lexical prefix check that does not resolve symlinks, which is fine for read/write
  but not for delete
- Refuse paths **shared with another stack** — `/DATA/AppData` is a common parent and
  deleting a sibling's data is unrecoverable; cross-check every other project's binds
- Re-resolve server-side and re-read the binds from Docker; the client's list is a
  request, not an authority, and may be minutes stale

**Principle carried over from the compose repair work:** when an operation can destroy
something the user did not explicitly name, it refuses and explains rather than proceeding.

---

## 4. Docker resource cleanup panel — DONE

Separate PR of its own — see [PLAN_disk_cleanup.md](PLAN_disk_cleanup.md) Feature B.

Kept apart because volume pruning deserves its own review pass: **204 of the 206 volumes**
on this host are "unused", and most of those are stopped stacks' databases, not garbage.
"Unused" means *not currently referenced*, which is not *not wanted*.

Implemented with all six categories, split into "safe to reclaim" and "needs thought", and
the headline total counts only the safe ones so it cannot invite reclaiming data by
accident.

Every prune names its category twice, once to select and once to confirm, and the route
rejects a mismatch with 422. That guard exists for a concrete reason: while probing which
prune endpoints the daemon exposed, the request
`POST /images/prune?filters=%7B%22dangling%22%3A%5B%22false%22%5D%7D&dry-run=1` removed
roughly 76 unused images from this host.
Docker has no dry-run for prune and ignored the unknown parameter. An endpoint that acts
on a bare POST is too easy to reach by accident — including by a tool — so ours does not.

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
