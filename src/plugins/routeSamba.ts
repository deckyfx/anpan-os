/**
 * Share management routes.
 *
 * SQLite stays the source of truth for the shares anpan-os owns; the active provider is
 * how they reach an SMB server. Which provider that is depends on the host — Samba where
 * it is installed, macOS native sharing otherwise — and these routes do not know or care
 * which, beyond reporting its capabilities to the browser.
 *
 * Every mutation writes the database first and publishes second, rolling the database back
 * if publishing fails. The alternative ordering leaves a share visible on the network that
 * anpan-os has no record of.
 */

import { Elysia, t } from "elysia";
import { stat }      from "node:fs/promises";
import { authGuard } from "./authGuard";
import { SambaShareStore } from "../stores/samba-share-store";
import {
  ShareError, requireShareProvider, shareProvider, statusFor,
  type DiscoveredShare, type ShareDefinition, type ShareProvider,
} from "../lib/shares";

/** Re-exported for callers that still speak in this shape. */
export type SambaShare = DiscoveredShare;

// ─── Helpers ─────────────────────────────────────────────────────────────────

interface Settable { status?: number | string }

/**
 * Run an operation against the active provider, turning ShareError into a status code.
 *
 * The alternative — every route catching and classifying for itself — is how the previous
 * version ended up answering 500 to a duplicate name and to a missing SMB server alike.
 */
async function withProvider<T>(
  set: Settable,
  fn: (provider: ShareProvider) => Promise<T>,
): Promise<T | { error: string }> {
  try {
    return await fn(await requireShareProvider());
  } catch (e) {
    if (e instanceof ShareError) {
      set.status = statusFor(e.kind);
      return { error: e.message };
    }
    set.status = 500;
    return { error: e instanceof Error ? e.message : "Share operation failed" };
  }
}

/** The shares anpan-os owns, straight from SQLite. */
async function managedShares(): Promise<ShareDefinition[]> {
  const rows = await SambaShareStore.findAll();
  return rows.map(r => ({
    name:       r.name,
    path:       r.path,
    comment:    r.comment,
    readOnly:   r.readOnly,
    browseable: r.browseable,
    guestOk:    r.guestOk,
  }));
}

/** Publish the current database state through the provider. */
async function publish(provider: ShareProvider): Promise<void> {
  await provider.sync(await managedShares());
}

export function sambaPlugin(jwtSecret: string) {
  return new Elysia({ prefix: "/api/samba" })
    .use(authGuard(jwtSecret))

    /**
     * Refuse writes when nothing would read the result.
     *
     * Reads stay available so the UI can explain the situation; only mutations are
     * blocked. Without this, a host with no usable SMB server accepts a share, stores it,
     * reports success, and serves nothing — the failure mode that is hardest to diagnose
     * because every screen says it worked.
     */
    .onBeforeHandle(async ({ set, request }) => {
      if (request.method === "GET") return;
      if (await shareProvider()) return;
      try {
        await requireShareProvider();
      } catch (e) {
        set.status = e instanceof ShareError ? statusFor(e.kind) : 501;
        return { error: e instanceof Error ? e.message : "No SMB server available" };
      }
    })

    // GET /api/samba/shares — our managed shares (from SQLite)
    .get("/shares", async ({ set }) => {
      try {
        return (await managedShares()).map(s => ({ ...s, source: "anpan" as const }));
      } catch {
        set.status = 500;
        return { error: "Failed to read shares" };
      }
    })

    /**
     * GET /api/samba/all-shares — everything this host publishes.
     *
     * Ownership is decided here rather than by the provider: only anpan-os knows which
     * names are in its database, and a backend like Open Directory records no author.
     */
    .get("/all-shares", async ({ set }) => {
      const provider = await shareProvider();
      if (!provider) return [];
      try {
        const ours      = await managedShares();
        const ourNames  = new Set(ours.map(s => s.name));
        const published = await provider.list();

        // Our own rows win: they carry the comment, which some backends cannot store.
        const external = published
          .filter(s => !ourNames.has(s.name))
          .map(s => ({ ...s, source: "external" as const }));

        return [...ours.map(s => ({ ...s, source: "anpan" as const })), ...external];
      } catch (e) {
        set.status = 500;
        return { error: e instanceof Error ? e.message : "Failed to read shares" };
      }
    })

    // POST /api/samba/shares — add a new share
    .post("/shares", async ({ body, set }) => {
      if (!/^[a-zA-Z0-9_\-]+$/.test(body.name)) {
        set.status = 422;
        return { error: "Share name may only contain letters, numbers, hyphens, and underscores" };
      }

      const pathStat = await stat(body.path).catch(() => null);
      if (!pathStat)              { set.status = 422; return { error: "Path does not exist" }; }
      if (!pathStat.isDirectory()){ set.status = 422; return { error: "Path is not a directory" }; }

      if (/[\n\r]/.test(body.path) || /[\n\r]/.test(body.comment ?? "")) {
        set.status = 422;
        return { error: "path and comment must not contain newline characters" };
      }

      if (await SambaShareStore.findByName(body.name)) {
        set.status = 409;
        return { error: "Share name already exists" };
      }

      return withProvider(set, async (provider) => {
        const created = await SambaShareStore.create({
          name:       body.name,
          path:       body.path,
          comment:    body.comment  ?? "",
          browseable: true,
          readOnly:   body.readOnly ?? false,
          guestOk:    body.guestOk  ?? true,
        });
        try {
          await publish(provider);
        } catch (e) {
          // Keep SQLite and the backend in step: a row nothing published is a share the
          // user is told exists and cannot reach.
          await SambaShareStore.deleteByName(created.name).catch(() => {});
          throw e;
        }
        return { ok: true };
      });
    }, {
      body: t.Object({
        name:     t.String({ minLength: 1 }),
        path:     t.String({ minLength: 1 }),
        comment:  t.Optional(t.String()),
        readOnly: t.Optional(t.Boolean()),
        guestOk:  t.Optional(t.Boolean()),
      }),
    })

    // PATCH /api/samba/shares/:name — update an existing share
    .patch("/shares/:name", async ({ params, body, set }) => {
      if (Object.keys(body).length === 0) {
        set.status = 422;
        return { error: "At least one field must be provided" };
      }
      if (body.comment !== undefined && /[\n\r]/.test(body.comment)) {
        set.status = 422;
        return { error: "comment must not contain newline characters" };
      }

      const before = await SambaShareStore.findByName(params.name);
      if (!before) { set.status = 404; return { error: "Share not found" }; }

      return withProvider(set, async (provider) => {
        await SambaShareStore.updateByName(params.name, body);
        try {
          await publish(provider);
        } catch (e) {
          await SambaShareStore.updateByName(params.name, {
            comment:    before.comment,
            readOnly:   before.readOnly,
            browseable: before.browseable,
            guestOk:    before.guestOk,
          }).catch(() => {});
          throw e;
        }
        return { ok: true };
      });
    }, {
      body: t.Object({
        comment:    t.Optional(t.String()),
        readOnly:   t.Optional(t.Boolean()),
        browseable: t.Optional(t.Boolean()),
        guestOk:    t.Optional(t.Boolean()),
      }),
    })

    // POST /api/samba/shares/take-over/:name — adopt a share defined elsewhere
    .post("/shares/take-over/:name", async ({ params, set }) => {
      return withProvider(set, async (provider) => {
        const ourNames = new Set((await managedShares()).map(s => s.name));
        if (ourNames.has(params.name)) {
          throw new ShareError("conflict", "Share name is already managed by anpan-os");
        }

        const target = (await provider.list()).find(s => s.name === params.name);
        if (!target) throw new ShareError("not-found", "External share not found");

        await SambaShareStore.create({
          name:       target.name,
          path:       target.path,
          // Backends that cannot store a comment return an empty one; give it a usable
          // default rather than leaving the share unlabelled in our own UI.
          comment:    target.comment || `AnpanOS share ${target.name}`,
          readOnly:   target.readOnly,
          browseable: target.browseable,
          guestOk:    target.guestOk,
        });

        try {
          await provider.adopt(target);
          await publish(provider);
        } catch (e) {
          await SambaShareStore.deleteByName(target.name).catch(() => {});
          throw e;
        }
        return { ok: true };
      });
    })

    // DELETE /api/samba/shares/:name
    .delete("/shares/:name", async ({ params, set }) => {
      const before = await SambaShareStore.findByName(params.name);
      if (!before) { set.status = 404; return { error: "Share not found" }; }

      return withProvider(set, async (provider) => {
        await SambaShareStore.deleteByName(params.name);
        try {
          // sync() only reconciles names it is given, so a removed share must also be
          // withdrawn explicitly — otherwise it stays published with no record of it.
          await provider.remove(params.name).catch((e) => {
            if (e instanceof ShareError && e.kind === "not-found") return;
            throw e;
          });
          await publish(provider);
        } catch (e) {
          await SambaShareStore.create({
            name:       before.name,
            path:       before.path,
            comment:    before.comment,
            readOnly:   before.readOnly,
            browseable: before.browseable,
            guestOk:    before.guestOk,
          }).catch(() => {});
          throw e;
        }
        return { ok: true };
      });
    })

    /**
     * GET /api/samba/setup-status — what backend is in charge and whether it is ready.
     *
     * `capabilities` is the field the UI needs most: it decides which inputs to render, so
     * a backend that cannot store a comment is never offered one to discard.
     */
    .get("/setup-status", async () => {
      const provider = await shareProvider();
      if (!provider) {
        return {
          provider: null,
          present:  false,
          ready:    false,
          detail:   "No SMB server is available on this system.",
          fixable:  false,
        };
      }
      const status = await provider.status();
      return {
        provider:     provider.id,
        providerName: provider.label,
        capabilities: provider.capabilities,
        // Retained under its old name so existing clients keep working.
        present:      status.ready,
        ready:        status.ready,
        detail:       status.detail,
        fixable:      status.fixable,
      };
    })

    // POST /api/samba/setup — one-time wiring, where the backend needs it
    .post("/setup", async ({ set }) =>
      withProvider(set, async (provider) => { await provider.setup(); return { ok: true }; }))

    // DELETE /api/samba/setup — undo it
    .delete("/setup", async ({ set }) =>
      withProvider(set, async (provider) => { await provider.teardown(); return { ok: true }; }))

    // POST /api/samba/rebuild — republish everything from SQLite
    .post("/rebuild", async ({ set }) =>
      withProvider(set, async (provider) => { await publish(provider); return { ok: true }; }))

    // POST /api/samba/reload — ask the server to re-read its configuration
    .post("/reload", async ({ set }) =>
      withProvider(set, async (provider) => { await provider.reload(); return { ok: true }; }));
}
