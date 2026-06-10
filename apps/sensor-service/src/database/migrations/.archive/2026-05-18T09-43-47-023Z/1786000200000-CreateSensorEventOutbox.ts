import { MigrationInterface, QueryRunner } from 'typeorm';
import { MigrationLogger } from '@aquaculture/backend-common/database';

/**
 * CreateSensorEventOutbox1786000200000
 * ============================================================================
 *
 * Adds `sensor.event_outbox` — the transactional-outbox table for the
 * Rust sensor-ingestion sidecar (ADR-029). The sidecar's write_tenant_batch
 * transaction enqueues a row here in the SAME postgres TX as the COPY
 * upsert; a separate `OutboxDispatcher` (crates/outbox-rs, landing in
 * a follow-up commit) claims pending rows via `FOR UPDATE SKIP LOCKED`
 * and publishes them to NATS. Atomicity of (metric write, event emit)
 * is bought back from the earlier in-memory mpsc design, which silently
 * dropped events on transient NATS unavailability.
 *
 * Per ADR-011 the table lives in the owning service's schema
 * (`sensor`), NOT `shared`. Each service owns its own outbox — farm,
 * hr, messaging already do (`farm_outbox`, `hr_outbox`,
 * `messaging_outbox`); this entry mirrors that convention.
 *
 * Schema design notes:
 *   - `id UUID PRIMARY KEY DEFAULT gen_random_uuid()` — opaque id that
 *     is not guessable and is safe to expose in error logs.
 *   - `tenant_id UUID NOT NULL` — tenant binding. Future cross-tenant
 *     RLS work can attach a policy against `current_setting('app.current_tenant')`
 *     with no application-layer change (the Rust sidecar already
 *     binds the GUC on every write — commit 368d8ac6).
 *   - `event_type TEXT NOT NULL` — the discriminator the dispatcher
 *     uses to route to the correct NATS subject family. Validated by
 *     the Rust outbox-rs repository layer (PascalCase, bounded
 *     length) before insert.
 *   - `payload JSONB NOT NULL` — the full event body. Dispatcher
 *     publishes this verbatim; no per-dispatch transformation.
 *   - `created_at`, `dispatched_at` — timestamps driving the worker's
 *     claim loop.
 *   - `dispatch_attempts INT NOT NULL DEFAULT 0` — monotonic counter
 *     incremented on each failed publish. DLQ threshold = 10 (see
 *     ADR-029). Rows with attempts >= 10 stay in the outbox for
 *     operator review; they are NOT auto-deleted.
 *   - `last_attempted_at TIMESTAMPTZ` — anchor for exponential
 *     backoff: the claim filter requires `last_attempted_at < NOW() -
 *     INTERVAL '100 ms' * power(2, LEAST(dispatch_attempts, 10))`.
 *   - `last_error TEXT` — truncated error description for operator
 *     diagnostic. Never stores attacker-controlled bytes (the NATS
 *     publish error chain is bounded).
 *
 * Indexes:
 *   - `idx_sensor_event_outbox_pending` — partial index on
 *     `(created_at)` WHERE `dispatched_at IS NULL`. Keeps the worker's
 *     claim loop O(log N) on pending rows regardless of the published
 *     archive size (published rows are cleaned nightly at 7d retention
 *     per the OutboxMaintenance task, but even if the archive grew the
 *     claim loop is unaffected).
 *   - `idx_sensor_event_outbox_tenant` — lookup by `(tenant_id,
 *     created_at)` for ops queries ("is tenant X producing events?")
 *     and for the eventual tenant-fair-scheduling experiment tracked
 *     in ADR-029 Alternatives.
 *
 * Rollback (`down`):
 *   `DROP TABLE sensor.event_outbox CASCADE` — veri kaybı, sadece
 *   dispatcher stop + pending_count = 0 invariant sağlandıktan sonra
 *   güvenli. The runbook `docs/runbooks/sensor-ingestion-rollback.md`
 *   (to be created with the Rust outbox-rs commit) documents the
 *   dispatcher-stop procedure.
 */
export class CreateSensorEventOutbox1786000200000 implements MigrationInterface {
  private readonly logger = new MigrationLogger(
    'CreateSensorEventOutbox1786000200000',
  );
  name = 'CreateSensorEventOutbox1786000200000';

  public async up(qr: QueryRunner): Promise<void> {
    // CREATE SCHEMA IF NOT EXISTS sensor — the sensor schema already
    // exists (every previous sensor migration asserts it), so this is
    // defensive. Skipping the check would make the migration brittle
    // to apply-order variation.
    await qr.query(`CREATE SCHEMA IF NOT EXISTS sensor`);

    // Single-chunk CREATE TABLE + CREATE INDEX. The migration SQL
    // linter's R3 rule (CREATE INDEX without CONCURRENTLY on a
    // pre-existing table) is exempt when the CREATE TABLE lives in
    // the SAME chunk — the table is empty at index-creation time, so
    // the ACCESS EXCLUSIVE the index grabs cannot stall writers.
    // Splitting this into three qr.query() calls would trip the rule
    // even though the table remains empty throughout; the single
    // query keeps the initial-schema exemption intact.
    //
    // Index rationale (same as the module docstring, here for the
    // SQL-level audit trail):
    //   - idx_sensor_event_outbox_pending is partial on
    //     WHERE dispatched_at IS NULL so the dispatcher's claim loop
    //     stays O(log pending) independent of archive growth.
    //   - idx_sensor_event_outbox_tenant covers ops queries and the
    //     future tenant-fair scheduling experiment ADR-029 flags.
    await qr.query(`
      CREATE TABLE IF NOT EXISTS sensor.event_outbox (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL,
        event_type TEXT NOT NULL,
        payload JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        dispatched_at TIMESTAMPTZ,
        dispatch_attempts INT NOT NULL DEFAULT 0,
        last_attempted_at TIMESTAMPTZ,
        last_error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_sensor_event_outbox_pending
        ON sensor.event_outbox (created_at)
        WHERE dispatched_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_sensor_event_outbox_tenant
        ON sensor.event_outbox (tenant_id, created_at);
    `);
    this.logger.log(
      'Created sensor.event_outbox + partial pending index + tenant index',
    );
  }

  public async down(qr: QueryRunner): Promise<void> {
    // Drop indexes first (safer than relying on CASCADE to pick them
    // up via the table drop — CASCADE also picks up dependent policies
    // / views a future commit might add, silently; explicit drops are
    // auditable).
    await qr.query(`DROP INDEX IF EXISTS sensor.idx_sensor_event_outbox_tenant`);
    await qr.query(`DROP INDEX IF EXISTS sensor.idx_sensor_event_outbox_pending`);

    // Safety check: refuse the drop if rows still exist. The rollback
    // runbook's precondition is "dispatcher stopped + pending_count =
    // 0"; a rollback that silently nukes in-flight events would be a
    // foot-gun. An operator who genuinely needs to force the drop can
    // truncate first and re-run down().
    const result: Array<{ count: string }> = await qr.query(
      `SELECT COUNT(*)::text AS count FROM sensor.event_outbox`,
    );
    const count = Number.parseInt(result[0]?.count ?? '0', 10);
    if (count > 0) {
      throw new Error(
        `sensor.event_outbox still contains ${count} row(s); rollback refuses to drop the table. ` +
          `Drain the dispatcher + truncate before re-running down(). ` +
          `See docs/runbooks/sensor-ingestion-rollback.md.`,
      );
    }

    await qr.query(`DROP TABLE IF EXISTS sensor.event_outbox`);
    this.logger.log('Dropped sensor.event_outbox');
  }
}
