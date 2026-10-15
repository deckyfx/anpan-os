import { test, expect, beforeAll, afterAll } from "bun:test";

/**
 * The upload dialog closes itself 800 ms after a batch finishes cleanly, by clearing the
 * store's upload rows. That timer once cleared unconditionally, so a second batch started
 * inside the window had its progress rows wiped while it was still uploading. These drive
 * the real store, with the network replaced: Bun has no XMLHttpRequest, which carries the
 * chunks, and the post-upload folder refresh would otherwise reach for a server.
 */

/** Per-file delay before a chunk is answered, so a test can hold one batch in flight. */
const delayFor = new Map<string, number>();

/** Just enough XMLHttpRequest for the store's chunk sender: answers each PUT with 200. */
class FakeXHR {
  status = 0;
  responseText = "";
  upload: { onprogress: ((e: { loaded: number }) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  private url = "";
  private timer: ReturnType<typeof setTimeout> | undefined;

  open(_method: string, url: string) { this.url = url; }
  setRequestHeader() {}
  send(body: Blob) {
    const query  = new URL(this.url, "http://store.test").searchParams;
    const offset = Number(query.get("offset") ?? 0);
    this.timer = setTimeout(() => {
      this.upload.onprogress?.({ loaded: body.size });
      this.status = 200;
      // What the server reports: the bytes it now holds.
      this.responseText = JSON.stringify({ ok: true, received: offset + body.size });
      this.onload?.();
    }, delayFor.get(query.get("name") ?? "") ?? 0);
  }
  abort() { clearTimeout(this.timer); this.onabort?.(); }
}

const realXHR   = globalThis.XMLHttpRequest;
const realFetch = globalThis.fetch;

beforeAll(() => {
  globalThis.XMLHttpRequest = FakeXHR as unknown as typeof XMLHttpRequest;
  // The folder refresh after each batch must not reach a real server.
  globalThis.fetch = (async () =>
    Response.json({ error: "offline" }, { status: 401 })) as unknown as typeof fetch;
});

afterAll(() => {
  globalThis.XMLHttpRequest = realXHR;
  globalThis.fetch = realFetch;
});

/** Poll until `cond` holds, or give up after `ms`. */
async function waitFor(cond: () => boolean, ms: number): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(10)) if (cond()) return true;
  return cond();
}

const files = (...names: string[]) =>
  names.map(n => new File([n], n)) as unknown as FileList;

test("a batch started inside the auto-close window keeps its progress rows", async () => {
  const { useFileStore } = await import("../src/public/app/stores/fileStore");
  const rows = () => useFileStore.getState().uploadItems;

  // The first batch is answered at once and finishes cleanly, arming its 800 ms clear.
  useFileStore.getState().handleUpload(files("first.txt"));
  expect(await waitFor(() => rows().length === 1 && rows().every(r => r.done), 1000)).toBe(true);

  // The second starts straight away -- well inside that window -- and is held in flight
  // past it.
  delayFor.set("second.txt", 1500);
  useFileStore.getState().handleUpload(files("second.txt"));

  await Bun.sleep(1000);                         // the first batch's timer has now fired
  expect(rows().map(r => r.name)).toEqual(["second.txt"]);
  expect(rows()[0]!.done).toBe(false);

  // Once the second batch finishes, its own timer still closes the dialog.
  expect(await waitFor(() => rows().length === 0, 3000)).toBe(true);
});
