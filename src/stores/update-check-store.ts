import { db } from "../db";
import { updateCheckRuns, imageUpdateState } from "../db/schema";
import { eq, desc, sql, and, notInArray, isNull } from "drizzle-orm";
import type { UpdateCheckRunRow, ImageUpdateStateRow } from "../db/schema";

/** How many run summaries to keep. Older ones are pruned as new runs start. */
const KEEP_RUNS = 20;

export interface ResultInput {
  stack: string;
  image: string;
  localDigest?: string | null;
  remoteDigest?: string | null;
  hasUpdate?: boolean;
  error?: string | null;
  skippedReason?: string | null;
}

/** When each recently deleted stack was fenced off from running sweeps; see fenceStack. */
const fencedAt = new Map<string, number>();

/** Repository for update-check runs and per-image update state. */
export class UpdateCheckStore {
  // Runs

  static async createRun(auto: boolean, total: number, scopeStack?: string | null): Promise<UpdateCheckRunRow> {
    const rows = await db.insert(updateCheckRuns)
      .values({ auto, total, status: "running", scopeStack: scopeStack ?? null })
      .returning();
    await UpdateCheckStore.pruneRuns();
    return rows[0]!;
  }

  static async findRun(id: number): Promise<UpdateCheckRunRow | null> {
    const rows = await db.select().from(updateCheckRuns).where(eq(updateCheckRuns.id, id)).limit(1);
    return rows[0] ?? null;
  }

  static async lastRun(): Promise<UpdateCheckRunRow | null> {
    const rows = await db.select().from(updateCheckRuns).orderBy(desc(updateCheckRuns.id)).limit(1);
    return rows[0] ?? null;
  }

  /**
   * The most recent run that covered every image.
   *
   * The staleness gate must consult this rather than the latest run of any kind: a check
   * scoped to one stack says nothing about the freshness of the other forty, and letting
   * it satisfy the gate would suppress full sweeps indefinitely for anyone who checks
   * individual stacks regularly.
   */
  static async lastFullRun(): Promise<UpdateCheckRunRow | null> {
    const rows = await db.select().from(updateCheckRuns)
      .where(isNull(updateCheckRuns.scopeStack))
      .orderBy(desc(updateCheckRuns.id)).limit(1);
    return rows[0] ?? null;
  }

  static async listRuns(limit = KEEP_RUNS): Promise<UpdateCheckRunRow[]> {
    return db.select().from(updateCheckRuns).orderBy(desc(updateCheckRuns.id)).limit(limit);
  }

  /** The run currently in flight, if any. Used to enforce single-flight across restarts. */
  static async runningRun(): Promise<UpdateCheckRunRow | null> {
    const rows = await db.select().from(updateCheckRuns)
      .where(eq(updateCheckRuns.status, "running"))
      .orderBy(desc(updateCheckRuns.id)).limit(1);
    return rows[0] ?? null;
  }

  static async recordProgress(
    id: number,
    completed: number,
    updatesFound: number,
    getFallbacks: number,
  ): Promise<void> {
    await db.update(updateCheckRuns)
      .set({ completed, updatesFound, getFallbacks, progressAt: new Date() })
      .where(eq(updateCheckRuns.id, id));
  }

  static async finishRun(
    id: number,
    status: "done" | "failed" | "cancelled" | "interrupted",
    error?: string | null,
  ): Promise<void> {
    await db.update(updateCheckRuns)
      .set({ status, error: error ?? null, finishedAt: new Date() })
      .where(eq(updateCheckRuns.id, id));
  }

  /**
   * Mark any run still flagged `running` as interrupted.
   *
   * Called on startup: a run is owned by the process that started it, so one left running
   * in the table means the process died mid-sweep. Without this the single-flight check
   * would refuse every future run, believing one is still in progress.
   */
  static async markOrphansInterrupted(): Promise<number> {
    const rows = await db.update(updateCheckRuns)
      .set({ status: "interrupted", finishedAt: new Date() })
      .where(eq(updateCheckRuns.status, "running"))
      .returning();
    return rows.length;
  }

  /** Keep only the most recent KEEP_RUNS summaries. */
  private static async pruneRuns(): Promise<void> {
    const keep = await db.select({ id: updateCheckRuns.id })
      .from(updateCheckRuns).orderBy(desc(updateCheckRuns.id)).limit(KEEP_RUNS);
    if (keep.length < KEEP_RUNS) return;
    await db.delete(updateCheckRuns).where(notInArray(updateCheckRuns.id, keep.map(r => r.id)));
  }

  // Per-image state

  /**
   * Upsert one image's outcome.
   *
   * `firstSeenAt` is preserved while an update remains outstanding and cleared once the
   * digests agree again, so it answers "how long has this been waiting" without a history
   * table behind it.
   */
  static async putResult(runId: number, r: ResultInput, sweepStartedAt?: number): Promise<ImageUpdateStateRow | null> {
    // Null, like a failed write: the sweep then neither counts nor publishes it.
    if (UpdateCheckStore.isFenced(r.stack, sweepStartedAt)) return null;
    const hasUpdate = r.hasUpdate ?? false;
    const now = new Date();
    const nowSeconds = Math.floor(now.getTime() / 1000);

    await db.insert(imageUpdateState)
      .values({
        stack: r.stack,
        image: r.image,
        localDigest: r.localDigest ?? null,
        remoteDigest: r.remoteDigest ?? null,
        hasUpdate,
        error: r.error ?? null,
        skippedReason: r.skippedReason ?? null,
        firstSeenAt: hasUpdate ? now : null,
        checkedAt: now,
        runId,
      })
      .onConflictDoUpdate({
        target: [imageUpdateState.stack, imageUpdateState.image],
        set: {
          localDigest: r.localDigest ?? null,
          remoteDigest: r.remoteDigest ?? null,
          hasUpdate,
          error: r.error ?? null,
          skippedReason: r.skippedReason ?? null,
          checkedAt: now,
          runId,
          // COALESCE keeps the original sighting so the age of an update is not reset by
          // every subsequent sweep; agreeing digests clear it.
          firstSeenAt: hasUpdate
            ? sql`COALESCE(${imageUpdateState.firstSeenAt}, ${nowSeconds})`
            : sql`NULL`,
        },
      })
      // Returning the stored row saves the caller a read: the sweep previously fetched
      // every row after each image to find the one it had just written, which is a full
      // table scan per image with six workers on one SQLite connection.
      .returning();

    const rows = await db.select().from(imageUpdateState)
      .where(and(eq(imageUpdateState.stack, r.stack), eq(imageUpdateState.image, r.image)))
      .limit(1);
    return rows[0] ?? null;
  }

  static async allState(): Promise<ImageUpdateStateRow[]> {
    return db.select().from(imageUpdateState).orderBy(imageUpdateState.stack, imageUpdateState.image);
  }

  static async outdated(): Promise<ImageUpdateStateRow[]> {
    return db.select().from(imageUpdateState).where(eq(imageUpdateState.hasUpdate, true));
  }

  /** Drop rows for images that no longer exist, so removed stacks stop showing badges. */
  static async retainOnly(pairs: Array<{ stack: string; image: string }>): Promise<void> {
    if (pairs.length === 0) {
      await db.delete(imageUpdateState);
      return;
    }
    const keep = new Set(pairs.map(p => `${p.stack}\0${p.image}`));
    const existing = await db.select({ stack: imageUpdateState.stack, image: imageUpdateState.image })
      .from(imageUpdateState);
    for (const row of existing) {
      if (!keep.has(`${row.stack}\0${row.image}`)) {
        await db.delete(imageUpdateState)
          .where(and(eq(imageUpdateState.stack, row.stack), eq(imageUpdateState.image, row.image)));
      }
    }
  }

  /**
   * Stop a sweep already in progress from writing results for a stack that was just deleted
   * or forgotten.
   *
   * The stack's rows are deleted with the stack (StackStore.delete), but a sweep that listed
   * it before the delete can still be checking it, and would write its row back and publish
   * it, so the update report would list a stack that no longer exists. Results from sweeps
   * that started after the fence are written normally, so a redeployed stack is checked again.
   */
  static fenceStack(stack: string, at = Date.now()): void {
    fencedAt.set(stack, at);
    // A fence only matters to sweeps already running, and none outlives an hour.
    for (const [name, t] of fencedAt) if (at - t > 60 * 60_000) fencedAt.delete(name);
  }

  /**
   * Whether `stack` was deleted at or after a sweep that started at `sweepStartedAt`.
   *
   * Checked when writing a result and again just before publishing it: a row written before
   * the delete is removed by it, but the worker still holds it and would otherwise announce it.
   */
  static isFenced(stack: string, sweepStartedAt: number | undefined): boolean {
    return sweepStartedAt !== undefined && (fencedAt.get(stack) ?? -Infinity) >= sweepStartedAt;
  }

  /** Remove all stored results and run history. Badges reappear after the next sweep. */
  static async purge(): Promise<{ runs: number; results: number }> {
    const runs    = (await db.delete(updateCheckRuns).returning()).length;
    const results = (await db.delete(imageUpdateState).returning()).length;
    return { runs, results };
  }
}
