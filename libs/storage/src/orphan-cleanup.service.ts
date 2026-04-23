/**
 * StorageOrphanCleanupService
 *
 * Deletes MinIO objects that have no corresponding database
 * reference, i.e. "orphans" that were uploaded successfully but
 * whose owning domain row was never written (client crashed
 * mid-flow) or was later erased (tenant erasure cascade, hard
 * delete, etc.). Without a sweep these objects accumulate
 * indefinitely — real storage cost and a latent surface for data
 * leakage through stale presigned URLs.
 *
 * The service is INTENTIONALLY agnostic about which domain
 * entities reference which paths. The caller (typically a
 * per-service cron job) enumerates every live path in its domain
 * and passes the set in. The library does the mechanical work:
 *
 *   1. List every object in the configured bucket (optionally
 *      scoped by prefix — e.g. by tenant for parallelism)
 *   2. Diff against the live-paths set — orphans = objects NOT
 *      in the set
 *   3. Age-gate — only delete orphans whose `lastModified` is
 *      older than `minAgeMs`. This is the critical safety
 *      threshold: a file may have been uploaded seconds ago with
 *      the DB write still in flight. Waiting 24+ hours eliminates
 *      the race by construction.
 *   4. Delete + report — return counts of deleted / kept /
 *      skipped-by-age / errors so the cron can log structured
 *      audit output.
 *
 * # What this service does NOT do
 *
 *   - Decide which paths are "live". That's domain knowledge,
 *     owned by the caller. Passing an incomplete live-set would
 *     delete files the domain still references; the caller is
 *     responsible for correctness.
 *   - Enforce tenant scoping. Callers typically run a separate
 *     cleanup per tenant (or a single global cleanup with a
 *     union of every tenant's live paths). The service accepts
 *     both shapes.
 *   - Handle soft-deletes. If the caller considers a soft-deleted
 *     row still "live" (e.g. for GDPR audit-trail purposes), its
 *     path must appear in the live set — the service does not
 *     read the DB.
 *   - Persist an audit log. The return value carries the stats
 *     the caller's cron should log / metric. The caller chooses
 *     the sink (farm-service writes to `farm_audit_logs`).
 *
 * Phase 6.2.3 of the "Farm modülü kalan kör noktalar" plan.
 * Closes Girdi 15-C4 sub-item (orphan cleanup — phase 6.2
 * partial landed the pre-upload validation; this lands the
 * post-upload sweep).
 */
import { Injectable, Logger } from '@nestjs/common';

import { MinioClientService } from './minio-client.service';

export interface OrphanCleanupRequest {
  /**
   * Set of paths currently referenced by a live database row.
   * Objects whose MinIO `name` is in this set are never
   * considered for deletion. Pass a `Set` (not an array) — the
   * service does `has()` lookups per object, which is O(1) on
   * Set and O(n) on array. On a bucket with 100k objects and a
   * 10k-path live set the difference is ~100× runtime.
   */
  livePaths: ReadonlySet<string>;

  /**
   * Minimum age (in milliseconds) an object must have at the
   * `lastModified` timestamp before it is considered for
   * deletion. Critical safety threshold — protects against
   * deleting a file that was uploaded seconds ago and whose DB
   * row is still in flight. Default: 24 hours. Callers should
   * only go lower in tests / staging.
   */
  minAgeMs?: number;

  /**
   * Optional bucket prefix to narrow the scan. On tenant-scoped
   * layouts the conventional prefix is `${tenantId}/` — callers
   * can run one cleanup per tenant in parallel for better
   * latency on large buckets. Default: `''` (scan the whole
   * bucket in one pass).
   */
  prefix?: string;

  /**
   * Upper bound on deletions per run — stops the loop once this
   * many objects have been removed. Prevents a runaway cleanup
   * from taking down a tenant's working set if the live-paths
   * set was accidentally constructed empty. Default: 10,000.
   */
  maxDeletions?: number;
}

export interface OrphanCleanupResult {
  /** Total objects seen in the bucket under the prefix. */
  totalScanned: number;
  /** Objects referenced by the live set — left alone. */
  live: number;
  /** Orphans deleted. */
  deleted: number;
  /** Orphans skipped because they were too new (under minAgeMs). */
  tooNew: number;
  /** Deletions stopped after hitting `maxDeletions`. */
  capped: boolean;
  /** Paths that errored during delete. Non-fatal — logged + reported. */
  errors: Array<{ path: string; error: string }>;
  /** Wall-clock duration of the run in milliseconds. */
  durationMs: number;
}

const DEFAULT_MIN_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
const DEFAULT_MAX_DELETIONS = 10_000;

@Injectable()
export class StorageOrphanCleanupService {
  private readonly logger = new Logger(StorageOrphanCleanupService.name);

  constructor(private readonly minioClient: MinioClientService) {}

  async cleanup(request: OrphanCleanupRequest): Promise<OrphanCleanupResult> {
    const start = Date.now();
    const minAgeMs = request.minAgeMs ?? DEFAULT_MIN_AGE_MS;
    const maxDeletions = request.maxDeletions ?? DEFAULT_MAX_DELETIONS;
    const prefix = request.prefix ?? '';
    const cutoff = new Date(Date.now() - minAgeMs);

    const objects = await this.minioClient.listObjects(prefix);

    let live = 0;
    let deleted = 0;
    let tooNew = 0;
    let capped = false;
    const errors: Array<{ path: string; error: string }> = [];

    for (const obj of objects) {
      if (request.livePaths.has(obj.name)) {
        live += 1;
        continue;
      }
      if (obj.lastModified > cutoff) {
        tooNew += 1;
        continue;
      }
      if (deleted >= maxDeletions) {
        capped = true;
        break;
      }
      try {
        await this.minioClient.deleteFile(obj.name);
        deleted += 1;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push({ path: obj.name, error: message });
        this.logger.warn(`Orphan cleanup delete failed for ${obj.name}: ${message}`);
      }
    }

    const durationMs = Date.now() - start;
    this.logger.log(
      `Orphan cleanup under prefix='${prefix}': scanned=${objects.length} ` +
        `live=${live} deleted=${deleted} tooNew=${tooNew} ` +
        `errors=${errors.length} capped=${capped} duration=${durationMs}ms`,
    );

    return {
      totalScanned: objects.length,
      live,
      deleted,
      tooNew,
      capped,
      errors,
      durationMs,
    };
  }
}
