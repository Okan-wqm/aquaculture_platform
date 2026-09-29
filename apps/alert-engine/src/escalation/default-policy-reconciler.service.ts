import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import {
  assertTenantTransactionContext,
  forEachVerifiedTenantSchema,
} from '@aquaculture/backend-common/database';
import {
  ScheduledJob,
  ScheduledJobRunner,
  type ScheduledJobExecutor,
} from '@aquaculture/backend-common/scheduling';
import { DataSource } from 'typeorm';

import { ensureDefaultEscalationPolicy } from './default-escalation-policy';
import { EscalationPolicyService } from './escalation-policy.service';

/** How often every active tenant is re-checked. */
const RECONCILE_EVERY_MS = 10 * 60 * 1000;

export interface DefaultPolicyReconcileSummary {
  tenants: number;
  created: number;
  failed: number;
}

/**
 * Level-triggered reconcile of the default escalation policy
 * (ALERT-CRITICAL-004).
 *
 * WHY: tenants provisioned before this code existed never received a
 * `TenantProvisioned` seed, and an edge-triggered seed can be lost. This job
 * re-asserts the invariant "every active tenant has a default policy" from
 * live state every tick, so coverage converges no matter which event was
 * missed.
 *
 * WHAT: the sanctioned verified fan-out (`forEachVerifiedTenantSchema`) hands
 * each ACTIVE tenant its own transaction with the tenant's schema on
 * search_path and its full UUID from the db-migrate ledger; the RLS GUC is
 * bound and read back (`assertTenantTransactionContext`) before the idempotent
 * insert. No per-schema SQL is written here, one tenant failing never stops
 * the rest, and the lease on `@ScheduledJob` keeps replicas from racing (the
 * unique default index would make a race harmless anyway).
 */
@Injectable()
export class DefaultPolicyReconcilerService {
  private readonly logger = new Logger(DefaultPolicyReconcilerService.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    @Inject(EscalationPolicyService)
    private readonly policyService: Pick<EscalationPolicyService, 'invalidateCache'>,
    @Inject(ScheduledJobRunner)
    readonly scheduledJobs: ScheduledJobExecutor,
  ) {}

  @ScheduledJob({ name: 'alert.default-escalation-policy.reconcile', every: RECONCILE_EVERY_MS })
  async reconcileScheduled(): Promise<void> {
    await this.reconcileAllTenants();
  }

  /** One full pass over every active tenant; returns what it did. */
  async reconcileAllTenants(): Promise<DefaultPolicyReconcileSummary> {
    const created: string[] = [];
    const results = await forEachVerifiedTenantSchema(
      this.dataSource,
      async ({ tenantId, queryRunner }) => {
        await assertTenantTransactionContext(queryRunner, 'alert', tenantId);
        const outcome = await ensureDefaultEscalationPolicy(queryRunner.manager, tenantId);
        if (outcome === 'created') created.push(tenantId);
      },
      { logger: this.logger },
    );

    // Cache invalidation only after the fan-out committed each tenant.
    for (const tenantId of created) {
      this.policyService.invalidateCache(tenantId);
    }

    const failed = results.filter((result) => result.outcome !== 'ok');
    for (const failure of failed) {
      this.logger.error(
        `Default escalation policy reconcile ${failure.outcome} for schema ${failure.schemaName}: ` +
          `${failure.error?.message ?? 'no error detail'}`,
      );
    }
    const summary = { tenants: results.length, created: created.length, failed: failed.length };
    if (summary.created > 0 || summary.failed > 0) {
      this.logger.log(
        `Default escalation policy reconcile: ${summary.created} seeded, ${summary.failed} failed ` +
          `of ${summary.tenants} active tenant(s)`,
      );
    }
    return summary;
  }
}
