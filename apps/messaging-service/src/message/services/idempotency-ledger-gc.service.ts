import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

/**
 * Retention horizon for message_send_idempotency rows (MSG-MEDIUM-001).
 *
 * This is the AUTHORITATIVE dedup window of the platform: a duplicate
 * send with the same idempotency key is guaranteed to be detected for
 * this long after the original. It MUST stay strictly greater than the
 * Redis fast-path TTL (7d, IDEMPOTENCY_TTL_SECONDS in
 * send-message.handler.ts) — otherwise a key could expire from the
 * ledger while clients still legitimately retry inside the cache
 * window, re-opening duplicates.
 */
export const IDEMPOTENCY_LEDGER_RETENTION_DAYS = 30;

/**
 * GC sweeper for the send-idempotency ledger.
 *
 * WHY a sweeper and NOT partitioning: the ledger exists precisely
 * because the partitioned `messages` table cannot carry a global
 * UNIQUE — partitioning the LEDGER by time would force its primary key
 * to include the partition column and re-create the exact problem the
 * table solves. A time-bounded DELETE keeps the unique anchor
 * partition-free.
 *
 * WHY GC failure does not crash the service (deliberate, narrow
 * fail-open): a missed sweep only lets the table grow — it can never
 * weaken the dedup guarantee, which gets STRONGER with retained rows.
 * The error is logged loudly for alerting and the next daily run
 * catches up.
 */
@Injectable()
export class IdempotencyLedgerGcService {
  private readonly logger = new Logger(IdempotencyLedgerGcService.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  /** Daily at 03:10 — off-peak, after the partition cron's monthly slot. */
  @Cron('10 3 * * *', { name: 'idempotency-ledger-gc' })
  async sweep(): Promise<void> {
    try {
      const result: unknown = await this.dataSource.query(
        `DELETE FROM messaging.message_send_idempotency
          WHERE "createdAt" < now() - make_interval(days => $1)`,
        [IDEMPOTENCY_LEDGER_RETENTION_DAYS],
      );
      const deleted = Array.isArray(result) && typeof result[1] === 'number' ? result[1] : 0;
      this.logger.log(
        `Idempotency ledger GC: removed ${deleted} row(s) older than ${IDEMPOTENCY_LEDGER_RETENTION_DAYS}d`,
      );
    } catch (err) {
      this.logger.error(
        `Idempotency ledger GC failed (table only grows until the next run; dedup guarantee unaffected): ${(err as Error).message}`,
      );
    }
  }
}
