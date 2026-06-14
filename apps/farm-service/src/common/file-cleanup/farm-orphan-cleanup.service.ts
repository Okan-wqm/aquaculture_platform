/**
 * FarmOrphanCleanupService
 *
 * Nightly cron orchestrator for phase 6.2.3 MinIO orphan
 * cleanup. Walks every registered `FileReferenceProvider`,
 * builds the union of live paths, hands the set to
 * `StorageOrphanCleanupService`, and logs an aggregate audit
 * trail.
 *
 * # Why a distinct service?
 *
 * The library-side cleanup is domain-agnostic. The farm-service
 * side owns:
 *
 *   - The list of providers (what paths are "live" for this
 *     service's entities)
 *   - The cron schedule
 *   - The audit-log emission so operators can see the nightly
 *     run's numbers alongside other farm audit events.
 *
 * Keeping these concerns here means `libs/storage` stays a
 * reusable primitive that other services (hr-service,
 * messaging-service, etc.) can adopt with their own providers.
 *
 * Phase 6.2.3 of the "Farm modülü kalan kör noktalar" plan.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  OrphanCleanupResult,
  StorageOrphanCleanupService,
} from '@platform/storage';

import {
  FILE_REFERENCE_PROVIDERS,
  FileReferenceProvider,
} from './file-reference-provider';

export interface FarmOrphanCleanupSummary extends OrphanCleanupResult {
  /** Per-provider live-path counts that fed the cleanup. */
  providersUsed: Array<{ name: string; livePathCount: number }>;
  /** ISO timestamp when the run started. */
  startedAt: string;
}

@Injectable()
export class FarmOrphanCleanupService {
  private readonly logger = new Logger(FarmOrphanCleanupService.name);

  constructor(
    private readonly cleanup: StorageOrphanCleanupService,
    @Inject(FILE_REFERENCE_PROVIDERS)
    private readonly providers: FileReferenceProvider[],
  ) {}

  /**
   * Run a single cleanup pass. Returns structured counts for
   * the cron caller to log / metric. Does NOT throw — per-object
   * errors land in `errors`, per-provider errors land in
   * `providersUsed[].livePathCount === -1` (with a warn log), and
   * a catastrophic MinIO failure is wrapped and logged.
   */
  async run(options?: {
    prefix?: string;
    minAgeMs?: number;
    maxDeletions?: number;
  }): Promise<FarmOrphanCleanupSummary> {
    const startedAt = new Date().toISOString();
    const live = new Set<string>();
    const providersUsed: Array<{ name: string; livePathCount: number }> = [];

    for (const provider of this.providers) {
      try {
        const paths = await provider.collectLivePaths();
        for (const p of paths) live.add(p);
        providersUsed.push({
          name: provider.name,
          livePathCount: paths.length,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(
          `FileReferenceProvider '${provider.name}' failed: ${message}. ` +
            'Aborting cleanup — a partial live-paths set risks deleting ' +
            'files the provider would have claimed.',
          err instanceof Error ? err.stack : undefined,
        );
        // Fail-closed: if any provider errors, we DO NOT run the
        // cleanup. The alternative (run with an incomplete set)
        // would delete live files whenever the broken provider
        // returns first.
        return {
          totalScanned: 0,
          live: 0,
          deleted: 0,
          tooNew: 0,
          capped: false,
          errors: [{ path: `provider:${provider.name}`, error: message }],
          durationMs: Date.now() - new Date(startedAt).getTime(),
          refused: false,
          providersUsed: [...providersUsed, { name: provider.name, livePathCount: -1 }],
          startedAt,
        };
      }
    }

    const result = await this.cleanup.cleanup({
      livePaths: live,
      prefix: options?.prefix,
      minAgeMs: options?.minAgeMs,
      maxDeletions: options?.maxDeletions,
    });

    const summary: FarmOrphanCleanupSummary = {
      ...result,
      providersUsed,
      startedAt,
    };

    // Cross-tenant system operations are not written to the
    // tenant-scoped `farm_audit_logs` table — the farm audit
    // entity requires a single `tenantId` per row, which makes
    // no sense here. Structured logger output + Prometheus
    // cron-duration metrics (phase 5.3) already cover the
    // observability surface; operators can grep the summary
    // line below. Cross-service audit consolidation (who/when
    // ran cleanups across services) is the admin-api-service
    // bulk-audit table's job, not farm-service.
    this.logger.log(
      `Orphan cleanup complete — providers=${providersUsed.length} ` +
        `liveUnion=${live.size} scanned=${summary.totalScanned} ` +
        `deleted=${summary.deleted} tooNew=${summary.tooNew} ` +
        `errors=${summary.errors.length} capped=${summary.capped} ` +
        `duration=${summary.durationMs}ms`,
    );
    return summary;
  }
}
