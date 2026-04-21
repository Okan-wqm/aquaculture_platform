import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';

import { MigrationEventEntity } from '../../database/entities/migration-event.entity';

/**
 * MigrationEventsRetentionService — ADR-024 enforcement for
 * observability.migration_events.
 *
 * Retention: 13 months (SOC2 CC4.1 12mo + 1mo buffer). Default
 * `MIGRATION_EVENTS_RETENTION_DAYS` = 395 (≈13 months). Configurable
 * via env var — operators can extend for extended-retention tenants
 * (per-tenant retention policy lives in a separate layer Phase 9+).
 *
 * # Schedule
 *
 * Runs daily at 03:00 UTC — off-hours on every deployment region the
 * platform currently operates in (FRA1 / Istanbul). Cron expression
 * comes from @nestjs/schedule's CronExpression.EVERY_DAY_AT_3AM
 * literal so it stays in sync with the library's parsing rules.
 *
 * # Scope
 *
 * Only rows where `occurred_at < NOW() - retentionDays` are deleted.
 * The service counts + logs but does NOT chunk-delete today — the
 * table's partial index on (tenant_id_hash, drift_class_id,
 * occurred_at DESC) keeps the range scan bounded, and a 13-month
 * rolling window produces ~30-day deletion batches under steady
 * state.
 *
 * Legal-hold exemptions are a Phase 9+ concern — a hold flag on
 * rows would suppress deletion. Not implemented yet; tracked in
 * the plan v3 legal-hold roster.
 */
@Injectable()
export class MigrationEventsRetentionService {
  private readonly logger = new Logger(MigrationEventsRetentionService.name);
  private readonly retentionDays: number;

  constructor(
    @InjectRepository(MigrationEventEntity)
    private readonly repo: Repository<MigrationEventEntity>,
    private readonly configService: ConfigService,
  ) {
    const raw = this.configService.get<string>(
      'MIGRATION_EVENTS_RETENTION_DAYS',
      '395',
    );
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
      throw new RangeError(
        `[MigrationEventsRetention] MIGRATION_EVENTS_RETENTION_DAYS must be a positive integer (got '${raw}')`,
      );
    }
    this.retentionDays = parsed;
  }

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async enforce(): Promise<void> {
    await this.enforceOnce();
  }

  /**
   * Public entry for manual invocation (CI / smoke test / operator
   * runbook). Returns the number of rows deleted.
   */
  async enforceOnce(now: Date = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - this.retentionDays * 86_400_000);
    const deleteResult = await this.repo.delete({
      occurredAt: LessThan(cutoff),
    });
    const deleted = deleteResult.affected ?? 0;
    if (deleted > 0) {
      this.logger.log(
        `retention enforced: deleted ${deleted} row(s) occurred_at < ${cutoff.toISOString()}`,
      );
    } else {
      this.logger.debug(
        `retention: no rows older than ${cutoff.toISOString()}`,
      );
    }
    return deleted;
  }
}
