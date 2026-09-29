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

import { AlertRule } from '../../database/entities/alert-rule.entity';
import { AlertEvaluationService } from './alert-evaluation.service';
import { RuleRecipientNormalizer } from './rule-recipient-normalizer.service';

/** How often every active tenant's rules are re-checked. */
const BACKFILL_EVERY_MS = 60 * 60 * 1000;

/** What one pass did for one tenant (the per-tenant report). */
export interface RuleRecipientBackfillTenantReport {
  tenantId: string;
  rulesUpdated: number;
  addressesReplaced: number;
}

export interface RuleRecipientBackfillSummary {
  tenants: number;
  failed: number;
  reports: RuleRecipientBackfillTenantReport[];
}

/**
 * The data migration of existing sensor rules' recipients (decision 7).
 *
 * WHY a reconcile job and not a TypeORM migration: the mapping "e-mail →
 * active user of the tenant" lives in auth-service's directory. A SQL migration
 * in alert-engine would have to read `auth.users` across schema ownership
 * (ADR-011); the job asks the owner over the same NATS query the write path
 * uses, so the backfill and new writes normalise identically.
 *
 * WHAT: blue-green safe and re-runnable. Each ACTIVE tenant (verified fan-out,
 * its own transaction, RLS read-back) has every rule whose recipients hold an
 * e-mail address of an active user rewritten to that user's id — the same
 * `RuleRecipientNormalizer` as the write path; a second run finds nothing to
 * change. Old code reading a normalised rule still delivers (it pages user
 * ids), so the rewrite is safe under either version. Per-tenant counts are
 * logged; a tenant whose directory lookup fails is reported and retried on the
 * next hourly pass, never aborting the others. The `@ScheduledJob` lease keeps
 * replicas from racing.
 */
@Injectable()
export class RuleRecipientBackfillService {
  private readonly logger = new Logger(RuleRecipientBackfillService.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly normalizer: RuleRecipientNormalizer,
    @Inject(AlertEvaluationService)
    private readonly evaluation: Pick<AlertEvaluationService, 'invalidateRuleCache'>,
    @Inject(ScheduledJobRunner)
    readonly scheduledJobs: ScheduledJobExecutor,
  ) {}

  @ScheduledJob({ name: 'alert.rule-recipient-normalization.backfill', every: BACKFILL_EVERY_MS })
  async backfillScheduled(): Promise<void> {
    await this.backfillAllTenants();
  }

  /** One pass over every active tenant. */
  async backfillAllTenants(): Promise<RuleRecipientBackfillSummary> {
    const reports: RuleRecipientBackfillTenantReport[] = [];
    const results = await forEachVerifiedTenantSchema(
      this.dataSource,
      async ({ tenantId, queryRunner }) => {
        await assertTenantTransactionContext(queryRunner, 'alert', tenantId);
        const rules = await queryRunner.manager.find(AlertRule, { where: { tenantId } });
        let rulesUpdated = 0;
        let addressesReplaced = 0;
        for (const rule of rules) {
          const { recipients, replaced } = await this.normalizer.normalize(
            tenantId,
            rule.recipients ?? [],
          );
          if (replaced === 0) continue;
          await queryRunner.manager.update(AlertRule, { id: rule.id, tenantId }, { recipients });
          rulesUpdated++;
          addressesReplaced += replaced;
        }
        reports.push({ tenantId, rulesUpdated, addressesReplaced });
      },
      { logger: this.logger },
    );

    for (const report of reports) {
      if (report.rulesUpdated === 0) continue;
      await this.evaluation.invalidateRuleCache(report.tenantId);
      this.logger.log(
        `Rule recipient normalisation: tenant ${report.tenantId} — ${report.rulesUpdated} rule(s), ` +
          `${report.addressesReplaced} e-mail address(es) replaced by user ids`,
      );
    }
    const failed = results.filter((result) => result.outcome !== 'ok');
    for (const failure of failed) {
      this.logger.error(
        `Rule recipient normalisation ${failure.outcome} for schema ${failure.schemaName}: ` +
          `${failure.error?.message ?? 'no error detail'}`,
      );
    }
    return { tenants: results.length, failed: failed.length, reports };
  }
}
