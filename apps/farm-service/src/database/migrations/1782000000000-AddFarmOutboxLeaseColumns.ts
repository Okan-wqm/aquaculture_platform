import { MigrationInterface, QueryRunner } from 'typeorm';
import { MigrationLogger } from '@aquaculture/backend-common/database';

/**
 * AddFarmOutboxLeaseColumns1782000000000
 * ============================================================================
 *
 * Adds `leasedAt` and `leasedBy` columns to `farm_outbox` so the
 * OutboxWorkerService can atomically claim rows across replicas via
 * `SELECT ... FOR UPDATE SKIP LOCKED` followed by a lease tag.
 *
 * # Why this fix exists
 *
 * Before this migration, multiple farm-service replicas running the
 * outbox worker would each `SELECT` the same unpublished rows — there
 * was no row-level claim mechanism. Every replica would then publish
 * every event. NATS `duplicate_window` (2 minutes) absorbed the duplicate
 * publishes, but:
 *
 *   - every replica burned DB UPDATE round-trips on rows another replica
 *     was already handling, causing update contention;
 *   - every replica consumed an `msgID` slot in the dedup cache, shrinking
 *     the cache window available for genuine retries;
 *   - under NATS degradation, the dedup window filled and duplicate events
 *     leaked through to the bridge and Socket.IO room.
 *
 * The effective deployment cap was therefore **one replica per outbox**.
 * That violates the enterprise horizontal-scale requirement in the farm
 * domain plan and leaves the service a single point of failure for
 * real-time event delivery.
 *
 * # Lease design — what these columns mean
 *
 * - `leasedAt  TIMESTAMPTZ NULL` — set to `NOW()` by the worker when it
 *   claims a row inside its lease-acquisition transaction, cleared
 *   (`NULL`) on successful publish or transient failure so the row is
 *   immediately re-eligible.
 * - `leasedBy  VARCHAR(128) NULL` — `${hostname}-${pid}` of the worker
 *   currently holding the lease. Purely informational: the polling
 *   predicate keys off `leasedAt` expiry, not `leasedBy` identity.
 *   Operators read this to answer "which pod is stuck on this row?"
 *   without cross-referencing logs.
 *
 * The worker polling predicate becomes:
 *
 *   WHERE "publishedAt" IS NULL
 *     AND "retryCount" < MAX_RETRIES
 *     AND ("leasedAt" IS NULL OR "leasedAt" < NOW() - LEASE_DURATION)
 *
 * Lease duration is `OUTBOX_LEASE_DURATION_MS` in the outbox library
 * (default 5 minutes). On worker crash, another replica re-claims the
 * row after at most 5 minutes — stuck-event worst case.
 *
 * # Nullable, no default — rolling deploy safety
 *
 * Both columns are nullable with no default. This means:
 *
 *   - existing rows take `NULL` for both columns — no backfill required,
 *     the ALTER is metadata-only in PostgreSQL 12+ and completes in
 *     milliseconds regardless of table size;
 *   - during rolling deploy, old worker pods that have not yet seen the
 *     new code ignore the new columns entirely — they simply do not
 *     write or read them, and their behaviour is unchanged;
 *   - new worker pods begin writing the columns as they come up. Mixed
 *     fleets temporarily have both lease-aware and lease-blind workers;
 *     correctness is preserved because NATS `msgID + duplicate_window`
 *     still absorbs any race.
 *
 * # Index considerations
 *
 * The existing partial index `idx_farm_outbox_poll ON ("createdAt")
 * WHERE "publishedAt" IS NULL` already narrows the worker's scan to
 * pending rows. The lease-expiry predicate is evaluated row-by-row on
 * that narrowed set; at realistic batch sizes (≤100) this is cheaper
 * than maintaining a compound index. `NOW() - INTERVAL` is not
 * immutable, so it cannot appear in a partial index WHERE clause anyway.
 *
 * # Idempotency
 *
 * Both `ALTER TABLE` statements use `ADD COLUMN IF NOT EXISTS` (PG 9.6+)
 * so the migration is safe to re-run on environments that already have
 * the columns (manually applied, previously rolled back, etc.). The
 * `down()` path drops both columns with `IF EXISTS` guards so rollback
 * also idempotent.
 *
 * # Locking
 *
 * `ALTER TABLE ... ADD COLUMN ... NULL` without a default takes an
 * ACCESS EXCLUSIVE lock for the duration of the catalog update only —
 * PostgreSQL does not rewrite the table. The operation completes in
 * single-digit milliseconds on outbox tables, which hold only
 * unpublished events.
 */
export class AddFarmOutboxLeaseColumns1782000000000
  implements MigrationInterface
{
  name = 'AddFarmOutboxLeaseColumns1782000000000';
  private readonly logger = new MigrationLogger(this.name);

  public async up(queryRunner: QueryRunner): Promise<void> {
    const schemaRows: Array<{ current_schema: string }> = await queryRunner.query(
      `SELECT current_schema()`,
    );
    const schema = schemaRows[0]?.current_schema;
    if (!schema) {
      throw new Error(
        'SELECT current_schema() returned no rows — cannot proceed with migration',
      );
    }
    this.logger.log(
      `Adding farm_outbox lease columns in schema "${schema}"`,
    );

    await queryRunner.query(
      `ALTER TABLE "${schema}"."farm_outbox" ` +
        `ADD COLUMN IF NOT EXISTS "leasedAt" TIMESTAMPTZ NULL`,
    );

    await queryRunner.query(
      `ALTER TABLE "${schema}"."farm_outbox" ` +
        `ADD COLUMN IF NOT EXISTS "leasedBy" VARCHAR(128) NULL`,
    );

    this.logger.log(
      `farm_outbox lease columns added (leasedAt, leasedBy) in schema "${schema}"`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const schemaRows: Array<{ current_schema: string }> = await queryRunner.query(
      `SELECT current_schema()`,
    );
    const schema = schemaRows[0]?.current_schema;
    if (!schema) {
      throw new Error('SELECT current_schema() returned no rows');
    }
    this.logger.warn(
      `Dropping farm_outbox lease columns in schema "${schema}" — ` +
        `multi-replica workers will fall back to lease-blind polling. ` +
        `This is a break-glass operation.`,
    );

    await queryRunner.query(
      `ALTER TABLE "${schema}"."farm_outbox" DROP COLUMN IF EXISTS "leasedBy"`,
    );

    await queryRunner.query(
      `ALTER TABLE "${schema}"."farm_outbox" DROP COLUMN IF EXISTS "leasedAt"`,
    );

    this.logger.warn(
      `farm_outbox lease columns dropped in schema "${schema}"`,
    );
  }
}
