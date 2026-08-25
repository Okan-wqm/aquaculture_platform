import { validateTenantSchemaName } from '@aquaculture/backend-common/database';
import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { TelemetryArchiveEvent } from './entities/telemetry-archive-event.entity';

/**
 * Earliest range boundary that may ever be considered for dropping: raw
 * data younger than this is always hot (Task 4's floor while Task 6's
 * export/verify pipeline is pending).
 */
export const RAW_HOT_FLOOR_DAYS = 90;

/**
 * Task 4 (SENSOR-HIGH-094): the retention gate. Deletion of raw telemetry
 * chunks is LEDGER-DRIVEN — an unverified range can never reach drop_chunks,
 * and the raw hypertable must never carry an autonomous retention policy.
 *
 * The orchestrator is deliberately inert in this commit: dropBefore() is the
 * gate Task 6's export pipeline calls once Parquet objects are independently
 * verified. TELEMETRY_RETENTION_ENABLED stays the operator kill-switch.
 */
@Injectable()
export class TelemetryRetentionOrchestratorService {
  private readonly logger = new Logger(TelemetryRetentionOrchestratorService.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  /** Append one state transition. The ONLY write path to the ledger. */
  async append(event: Omit<TelemetryArchiveEvent, 'id' | 'occurredAt'>): Promise<void> {
    // Validate the schema shape before it reaches any SQL or storage.
    validateTenantSchemaName(event.tenantSchema);
    await this.dataSource
      .createQueryBuilder()
      .insert()
      .into(TelemetryArchiveEvent)
      .values(event as TelemetryArchiveEvent)
      .execute();
  }

  /**
   * The newest state per operation covering [rangeStart, rangeEnd). A drop
   * is legal only when EVERY tenant-day intersecting the boundary has its
   * newest transition at VERIFIED (a later FAILED/DROPPED/EXPORT_STARTED
   * overrides an earlier VERIFIED).
   */
  async latestStateForRange(
    tenantId: string,
    rangeStart: Date,
    rangeEnd: Date,
  ): Promise<Array<{ operationId: string; state: string; rangeStart: Date; rangeEnd: Date }>> {
    const rows = await this.dataSource
      .createQueryBuilder(TelemetryArchiveEvent, 'e')
      .select('DISTINCT ON (e.operationId) e.operationId AS "operationId", e.state AS "state", e.rangeStart AS "rangeStart", e.rangeEnd AS "rangeEnd"')
      .where('e.tenantId = :tenantId', { tenantId })
      .andWhere('e.rangeStart < :rangeEnd', { rangeEnd })
      .andWhere('e.rangeEnd > :rangeStart', { rangeStart })
      .orderBy('e.operationId', 'ASC')
      .addOrderBy('e.occurredAt', 'DESC')
      .getRawMany();
    return rows as Array<{ operationId: string; state: string; rangeStart: Date; rangeEnd: Date }>;
  }

  /**
   * THE GATE (Task 4 Step 4.1): refuse any drop boundary containing an
   * unverified tenant range. drop_chunks is unreachable while a single
   * intersecting operation's newest state is not VERIFIED — including the
   * "0 == 0" trap: a range with NO ledger rows at all is unverified, never
   * trivially droppable.
   */
  async dropBefore(tenantId: string, boundary: Date, dropChunks: () => Promise<void>): Promise<void> {
    const enabled =
      process.env['TELEMETRY_RETENTION_ENABLED'] === 'true';
    if (!enabled) {
      throw new Error(
        'TELEMETRY_RETENTION_ENABLED is not true — the ledger-driven retention gate refuses to run',
      );
    }

    const hotFloor = new Date(Date.now() - RAW_HOT_FLOOR_DAYS * 24 * 60 * 60 * 1000);
    if (boundary > hotFloor) {
      throw new Error(
        `Drop boundary ${boundary.toISOString()} is inside the ${RAW_HOT_FLOOR_DAYS}-day hot floor`,
      );
    }

    const states = await this.latestStateForRange(tenantId, new Date(0), boundary);
    const unverified = states.filter((s) => s.state !== 'VERIFIED');
    if (unverified.length > 0) {
      throw new Error(
        `Unverified archive range: ${unverified
          .map((s) => `${s.operationId}@${s.state}`)
          .join(', ')} — drop refused`,
      );
    }

    await dropChunks();
    this.logger.log(`Ledger-verified drop executed for tenant ${tenantId} before ${boundary.toISOString()}`);
  }
}
