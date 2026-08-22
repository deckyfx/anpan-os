# Plan — reclaiming disk: bind paths on delete, and Docker prune

Two related features. Both are about disk that anpan-os currently knows is wasted but
gives you no way to reclaim. Measured on this host:

| | reclaimable |
|---|---|
| Images | 27.6 GB (47%) |
| Build cache | 9.9 GB |
| Local volumes | 4.1 GB — 204 of 206 unused |
| **Total** | **~41 GB** |

---

## Feature A — offer to delete bind paths when removing a stack

### Where it stands

`GET /api/docker/stacks/:name/binds` already resolves every bind-mounted host path for a
stack, skipping the infrastructure ones (`docker.sock`, `localtime`, `hosts`…). The delete
dialog already lists them under *"Host paths — will remain on disk"*. So the discovery
work is done; only the acting on it is missing, and `routeDocker` says so plainly:
*"Bind-mounted host paths are intentionally left untouched."*

### Why it was left that way, and why that should change

Deleting a host directory is the most destructive thing anpan-os could do — it is not a
container that can be recreated from a compose file, it is the user's data. That caution
was right as a default. But the current outcome is that removing a stack silently leaves
gigabytes behind in `/DATA/AppData/<app>`, and the only hint is a line of text that
disappears with the dialog.

### Shape

Opt-in per path, never a blanket checkbox:

- Each path gets its own checkbox, **all unchecked by default**
- Each row shows its **size** (`du -sb` for every path in one `Promise.all` before the response, so sizes arrive with the list rather than lazily
- Paths **outside** `config.filesRoot` are shown but not selectable, since the file
  manager's own guard would refuse them anyway
- A path that is **shared with another stack** is flagged and not selectable — worth a
  cross-check against every other project's binds, because `/DATA/AppData` is a common
  parent and deleting a sibling's data would be unrecoverable
- Deletion happens **after** the containers are gone, streamed over the existing SSE
  channel, and a failure to remove one path does not fail the whole operation

### Guards

- Refuse anything that resolves to `/`, `/DATA`, `/DATA/AppData`, a home directory, or
  any path with fewer than two segments below the files root
- Re-resolve and re-check every path server-side; the client's list is a request, not an
  authority
- Require the path to have actually been a bind mount of that stack — re-read from Docker
  rather than trusting what the dialog was showing, which may be minutes stale

---

## Feature B — Docker resource cleanup

### Scope

A "Cleanup" panel showing what each category would reclaim, with per-category action.
Docker's own endpoints do the work: `/images/prune`, `/volumes/prune`, `/networks/prune`,
`/build/prune`, `/containers/prune`.

| Category | Default filter | Risk |
|---|---|---|
| Dangling images | `dangling=true` | Low — untagged layers nothing references |
| Unused images | `dangling=false` | **High** — removes any image no container uses, including ones you pulled deliberately and stacks that are merely stopped |
| Build cache | — | Low |
| Unused volumes | — | **Highest** — an unused named volume is often a stopped stack's database |
| Stopped containers | — | Medium |
| Unused networks | — | Low |

### The distinction that matters

"Unused" means *not currently referenced by a container*, which is not the same as *not
wanted*. A stack you stopped last week has unused volumes holding its data, and 204 of the
206 volumes on this host are "unused". A single confirm-all button over that set would be
a data-loss incident, not a cleanup.

So: **per-category selection, each with its own confirm**, dangling-only as the default
image filter, and volumes never included in any "clean everything" affordance. Show the
reclaimable figure per category from `/system/df` so the choice is informed.

### Shape

- `GET /api/docker/disk-usage` — wraps `/system/df`, per-category totals and reclaimable
- `POST /api/docker/prune/:kind` — one kind per call, never a batch; SSE for progress
  since pruning tens of gigabytes is not instant
- UI: a Cleanup dialog reachable from the Docker summary bar, which already shows image
  and volume counts and is the natural place to ask "why so many?"

### Also worth fixing here

The summary bar's image count reads **192** from `/info`, while `docker images` shows 132
rows over **111 unique image IDs** — `/info` counts image records and `docker images`
lists one row per tag. Counting unique IDs from `/images/json` gives the number a person
means, and matches the family Portainer reports. Cheap to do while adding `/disk-usage`.

---

## Sequencing

1. Image count correction — small, independent, immediately visible
2. `GET /api/docker/disk-usage` + Cleanup dialog, **dangling images and build cache only**
   (the two low-risk, high-yield categories: ~37 GB here)
3. Bind paths on stack delete — the guards are the bulk of the work
4. Volumes and unused-images pruning, once the confirm patterns from 2 and 3 are proven

Nothing here should ship without the orphan-guard lesson from the compose repair work: when
an operation can destroy something the user did not explicitly name, it refuses and
explains rather than proceeding.
