/**
 * File uploads are sent in chunks, each well under Bun.serve's 128 MB default body limit.
 *
 * A single-request upload of a 4 GB ISO hit that limit and was cut off after a few hundred
 * KB. Raising the limit for one route needs a global request hook, and any global hook stops
 * Elysia from serving the SPA's HTML bundle natively — every page came back as the bundle's
 * JSON description. Chunks avoid both, and a dropped chunk is retried on its own instead of
 * restarting the whole file.
 *
 * Shared by the server route and the client so the two cannot disagree.
 */
export const UPLOAD_CHUNK_SIZE = 32 * 1024 * 1024;

/** The server refuses a chunk larger than this — headroom over UPLOAD_CHUNK_SIZE, far below Bun's limit. */
export const UPLOAD_CHUNK_MAX = 64 * 1024 * 1024;

/** An upload's id: a UUID the client generates, naming its temp file. */
export const UPLOAD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
