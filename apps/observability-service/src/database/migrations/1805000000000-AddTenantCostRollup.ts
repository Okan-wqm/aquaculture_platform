import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AddTenantCostRollup1805000000000
 * ============================================================================
 *
 * Phase 12.5 of docs/plans/2026-04-17-agentic-post-audit-consolidation-plan.md.
 *
 * Creates `observability.tenant_cost_rollup` — the TimescaleDB hypertable
 * that aggregates per-tenant platform cost telemetry hourly. Consumed by:
 *
 *   - tenant-cost-attribution-agent (Phase 9.6) — reads the rollup +
 *     Stripe invoice state to produce the monthly reconciliation report.
 *   - observability-service dashboards — per-tenant cost explorer +
 *     plan-tier margin SLO panels.
 *   - alert-engine — cost-explosion alert fires when a tenant's hourly
 *     cost_usd exceeds plan_tier_budget_usd × 1.5 (non-critical features
 *     auto-disabled + tenant-admin notified).
 *
 * # Schema shape
 *
 *   (bucket, tenant_id, cost_category, cost_subcategory)
 *   → cost_usd + underlying meter units + counters
 *
 * Partition key: `bucket TIMESTAMPTZ` — 1-day chunks. Scale estimate:
 *   ~100 tenants × 12 categories × 24 hours/day = ~29k rows/day.
 *   Well within the "~25M rows/chunk at steady state" guideline from
 *   layer-1-timescaledb.md; 1-day chunks over-provision but keep
 *   retention policies simple (drop-chunk = drop-day).
 *
 * # Cost categories (canonical — matches cost-attribution lib)
 *
 *   - ai_tokens          : Anthropic Claude input/output + cache tokens
 *   - compute_cpu        : service CPU-hours (Prometheus container_cpu*)
 *   - compute_memory     : service memory-hours
 *   - storage_postgres   : per-tenant-schema bytes + IOPS
 *   - storage_minio      : S3-compatible object storage bytes + egress
 *   - storage_timescale  : hypertable bytes (compressed + uncompressed)
 *   - network_egress     : outbound bytes (GB × DO network rate)
 *   - nats_messages      : per-tenant JetStream message count
 *   - notification_push  : FCM / APNs dispatch count × provider rate
 *   - notification_email : SMTP dispatch count × provider rate
 *   - notification_sms   : Twilio dispatch count × provider rate
 *   - notification_webhook: outbound HTTPS call count (egress-only cost)
 *
 * Adding a new category is an explicit ADR extension: the cost-
 * attribution pipeline's invariant is that every non-zero cost
 * attribution to a tenant lands in ONE category (no double-counting),
 * enforced by the per-hour UNIQUE constraint below.
 *
 * # Retention
 *
 *   - raw hourly hypertable: 90 days.
 *   - monthly rollup (continuous aggregate added in a follow-up
 *     migration): 7 years (Stripe invoice reconciliation window).
 *
 * # Why NOT inside a tenant schema
 *
 *   `tenant_cost_rollup` is cross-tenant BY DESIGN — platform ops
 *   needs to query aggregate cost across all tenants (plan-margin
 *   reporting, cost-explosion comparison, fraud detection). A
 *   per-tenant schema table prevents the aggregate view. The
 *   observability schema is the correct home.
 *
 * # RLS
 *
 *   Enabled with tenant-scoped policy: app.current_tenant must match
 *   the row's tenant_id when the query is run under a tenant-scoped
 *   role. Platform-ops role (observability_service_admin) bypasses
 *   the policy for cross-tenant rollup queries. Pattern mirrors
 *   ADR-011 shared-schema tables (audit_logs et al).
 */
export class AddTenantCostRollup1805000000000 implements MigrationInterface {
  name = 'AddTenantCostRollup1805000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL search_path = 'observability', 'public'`);

    // ------------------------------------------------------------------
    // Core hypertable — CREATE TABLE + indexes in one chunk (R3
    // initial-schema exemption).
    // ------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS observability.tenant_cost_rollup (
        bucket TIMESTAMPTZ NOT NULL,
        tenant_id UUID NOT NULL,
        cost_category VARCHAR(32) NOT NULL
          CHECK (cost_category IN (
            'ai_tokens', 'compute_cpu', 'compute_memory',
            'storage_postgres', 'storage_minio', 'storage_timescale',
            'network_egress', 'nats_messages',
            'notification_push', 'notification_email',
            'notification_sms', 'notification_webhook'
          )),
        cost_subcategory VARCHAR(64) NOT NULL DEFAULT '',

        -- Cost in USD with 6-decimal precision (0.000001 USD = 1/100 of
        -- a cent; matches Anthropic's per-token pricing granularity).
        cost_usd NUMERIC(18, 6) NOT NULL DEFAULT 0,

        -- Underlying meter values (category-specific semantics).
        meter_primary NUMERIC(20, 6) NOT NULL DEFAULT 0,
        meter_secondary NUMERIC(20, 6) NOT NULL DEFAULT 0,

        -- Attribution provenance + plan tier at roll-up time (for
        -- historical plan-tier queries; current tier may differ).
        plan_tier VARCHAR(32) NOT NULL,
        source_service VARCHAR(64) NOT NULL,

        -- When the rollup row was computed (not the same as bucket).
        computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        -- UNIQUE key prevents double-attribution within a bucket.
        -- The cost-attribution pipeline's idempotency invariant relies
        -- on this — repeated hourly runs UPSERT (ON CONFLICT) rather
        -- than duplicate.
        CONSTRAINT tenant_cost_rollup_unique
          UNIQUE (bucket, tenant_id, cost_category, cost_subcategory)
      );

      CREATE INDEX IF NOT EXISTS tenant_cost_rollup_tenant_bucket_idx
        ON observability.tenant_cost_rollup (tenant_id, bucket DESC);
      CREATE INDEX IF NOT EXISTS tenant_cost_rollup_category_bucket_idx
        ON observability.tenant_cost_rollup (cost_category, bucket DESC);
      CREATE INDEX IF NOT EXISTS tenant_cost_rollup_plan_tier_idx
        ON observability.tenant_cost_rollup (plan_tier, bucket DESC);
    `);

    // ------------------------------------------------------------------
    // RLS — MUST run BEFORE the TimescaleDB compression / columnstore
    // block below. TimescaleDB ≥ 2.18 reframes `timescaledb.compress` as
    // "columnstore mode" on the hypertable; once columnstore is on, the
    // engine rejects subsequent vanilla `ALTER TABLE ENABLE/FORCE ROW
    // LEVEL SECURITY` with:
    //
    //   ERROR: operation not supported on hypertables that have
    //          columnstore enabled
    //
    // RLS is metadata + policy state that lives at the relation level,
    // independent of the chunk-storage layout, so it is safe to set
    // before the table becomes a hypertable; `create_hypertable()`
    // preserves the policy. Architecturally this also matches the
    // "configure access control before storage layout" ordering used
    // for ADR-011 shared-schema tables (audit_logs et al).
    // ------------------------------------------------------------------
    await queryRunner.query(`
      ALTER TABLE observability.tenant_cost_rollup ENABLE ROW LEVEL SECURITY
    `);
    await queryRunner.query(`
      ALTER TABLE observability.tenant_cost_rollup FORCE ROW LEVEL SECURITY
    `);
    await queryRunner.query(`
      DROP POLICY IF EXISTS tenant_cost_rollup_tenant_scope
        ON observability.tenant_cost_rollup
    `);
    await queryRunner.query(`
      CREATE POLICY tenant_cost_rollup_tenant_scope
        ON observability.tenant_cost_rollup
        FOR ALL
        TO PUBLIC
        USING (
          tenant_id::text = current_setting('app.current_tenant', true)
          OR current_setting('app.platform_role', true) = 'observability_service_admin'
        )
        WITH CHECK (
          tenant_id::text = current_setting('app.current_tenant', true)
          OR current_setting('app.platform_role', true) = 'observability_service_admin'
        )
    `);

    // ------------------------------------------------------------------
    // Convert to TimescaleDB hypertable — if the extension is available.
    // Mirrors the graceful-skip pattern from sensor-service migrations
    // (dev/CI may run on pure PG without timescaledb).
    // Order is load-bearing: RLS block above MUST land first (see note).
    // ------------------------------------------------------------------
    const timescaleAvailable = await this.checkTimescaleDB(queryRunner);
    if (timescaleAvailable) {
      await queryRunner.query(`
        SELECT create_hypertable(
          'observability.tenant_cost_rollup',
          'bucket',
          chunk_time_interval => INTERVAL '1 day',
          if_not_exists => TRUE
        )
      `);

      // Compression — old buckets rarely re-queried at per-row grain.
      // Enabling this flips the hypertable into TimescaleDB ≥ 2.18
      // columnstore mode, which locks out any subsequent ALTER TABLE
      // operations that aren't TimescaleDB-aware (RLS, FK, CHECK adds).
      // Anything new must land in a separate migration BEFORE this
      // ALTER, not after.
      await queryRunner.query(`
        ALTER TABLE observability.tenant_cost_rollup
          SET (
            timescaledb.compress,
            timescaledb.compress_segmentby = 'tenant_id, cost_category',
            timescaledb.compress_orderby = 'bucket DESC'
          )
      `);
      await queryRunner.query(`
        SELECT add_compression_policy(
          'observability.tenant_cost_rollup',
          INTERVAL '14 days',
          if_not_exists => TRUE
        )
      `);

      // Retention — 90 days raw grain. Monthly rollup (continuous
      // aggregate) lands in a follow-up migration with 7-year retention.
      await queryRunner.query(`
        SELECT add_retention_policy(
          'observability.tenant_cost_rollup',
          INTERVAL '90 days',
          if_not_exists => TRUE
        )
      `);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL search_path = 'observability', 'public'`);

    // First detach TimescaleDB-managed background jobs so that DROP
    // TABLE doesn't race with retention or compression workers. The
    // policies' if_exists flag makes this idempotent under partial
    // teardown.
    const timescaleAvailable = await this.checkTimescaleDB(queryRunner);
    if (timescaleAvailable) {
      await queryRunner.query(`
        SELECT remove_retention_policy(
          'observability.tenant_cost_rollup', if_exists => TRUE
        )
      `);
      await queryRunner.query(`
        SELECT remove_compression_policy(
          'observability.tenant_cost_rollup', if_exists => TRUE
        )
      `);
    }

    // DROP TABLE CASCADE tears down everything else in one shot —
    // policies, RLS state, indexes, hypertable metadata, columnstore
    // chunks. Avoids the columnstore-vs-ALTER restriction entirely; no
    // intermediate ALTER TABLE / DROP POLICY needed.
    await queryRunner.query(`
      DROP TABLE IF EXISTS observability.tenant_cost_rollup CASCADE
    `);
  }

  private async checkTimescaleDB(queryRunner: QueryRunner): Promise<boolean> {
    try {
      const result: Array<{ exists: boolean }> = await queryRunner.query(`
        SELECT EXISTS (
          SELECT 1 FROM pg_extension WHERE extname = 'timescaledb'
        )
      `);
      return result[0]?.exists === true;
    } catch {
      return false;
    }
  }
}
