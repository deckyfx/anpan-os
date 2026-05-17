import { Elysia, t } from "elysia";
import { authGuard } from "./authGuard";
import { BookmarkStore } from "../stores/bookmark-store";

/** CRUD plugin for external-app bookmarks. All routes require an active session. */
export function bookmarksPlugin(jwtSecret: string) {
  return new Elysia({ prefix: "/api/bookmarks" })
    .use(authGuard(jwtSecret))

    .get("/", async () => BookmarkStore.findAll())

    .post(
      "/",
      async ({ body, set }) => {
        const bookmark = await BookmarkStore.create({
          title:   body.title,
          url:     body.url,
          icon:    body.icon ?? null,
          note:    body.note ?? null,
          orderNo: body.orderNo ?? null,
        });
        set.status = 201;
        return bookmark;
      },
      {
        body: t.Object({
          title:   t.String({ minLength: 1 }),
          url:     t.String({ minLength: 1 }),
          icon:    t.Optional(t.String()),
          note:    t.Optional(t.String()),
          orderNo: t.Optional(t.Number()),
        }),
      },
    )

    .patch(
      "/:id",
      async ({ params, body, set }) => {
        const id = parseInt(params.id, 10);
        if (isNaN(id)) { set.status = 400; return { error: "Invalid id" }; }
        const updated = await BookmarkStore.update(id, body);
        if (!updated) { set.status = 404; return { error: "Bookmark not found" }; }
        return updated;
      },
      {
        params: t.Object({ id: t.String() }),
        body: t.Object({
          title:   t.Optional(t.String({ minLength: 1 })),
          url:     t.Optional(t.String({ minLength: 1 })),
          icon:    t.Optional(t.Union([t.String(), t.Null()])),
          note:    t.Optional(t.Union([t.String(), t.Null()])),
          orderNo: t.Optional(t.Union([t.Number(), t.Null()])),
        }),
      },
    )

    .delete(
      "/:id",
      async ({ params, set }) => {
        const id = parseInt(params.id, 10);
        if (isNaN(id)) { set.status = 400; return { error: "Invalid id" }; }
        const deleted = await BookmarkStore.delete(id);
        if (!deleted) { set.status = 404; return { error: "Bookmark not found" }; }
        return { ok: true };
      },
      { params: t.Object({ id: t.String() }) },
    );
}
