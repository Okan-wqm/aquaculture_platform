import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CreateTenantErasureAudit1788500000000
 * ============================================================================
 *
 * Creates `farm.tenant_erasure_audit` — the persistent audit record of
 * GDPR-Art-17 erasure cascades. Closes the COMPLIANCE-MEDIUM-004
 * idempotency gap on `TenantErasureService.confirm()`.
 *
 * # Why the table shape mirrors ErasureResult
 *
 * `confirm()` returns an ErasureResult struct with:
 *   - tenantId, confirmedAt, requestedBy
 *   - deletedRowsByTable (Record<string, number>)
 *   - totalDeleted, auditRowsAnonymised
 *
 * On re-confirm of an already-erased tenant, the service rebuilds
 * the SAME ErasureResult byte-identical — so every consumer (HTTP
 * client, Nest filter chain, etc.) gets a 200 + the same JSON
 * shape regardless of whether it's the first or N-th call. This
 * requires every field to be persisted on the row.
 *
 * # Why JSONB for deletedRowsByTable
 *
 * The per-table breakdown is variable-cardinality (the set of
 * tenant-scoped entity tables changes as the platform evolves).
 * A column-per-table approach would require a migration on every
 * new tenant-scoped entity. JSONB is the correct shape for
 * unbounded sparse maps — the layer-1-typeorm rule against jsonb-
 * as-dumping-ground does NOT apply here because the shape is
 * documented and stable (string → integer, no nesting).
 *
 * # Why PRIMARY KEY tenantId
 *
 * Enforces "one erasure per tenant lifetime" at the DB level. A
 * future bug that bypasses the service-layer idempotency check
 * still hits the unique constraint and fails LOUD. Tier-1
 * belt + suspenders.
 *
 * # No CONCURRENTLY indexes needed
 *
 * tenant_erasure_audit is a single-row-per-tenant table; the
 * primary-key btree is the only index required. Queries are
 * always `WHERE tenantId = ?` which uses the PK directly.
 *
 * Closes: docs/reviews/compliance-expert/2026-04-28-core-platform-review.md#COMPLIANCE-MEDIUM-004
 */
export class CreateTenantErasureAudit1788500000000
  implements MigrationInterface
{
  name = 'CreateTenantErasureAudit1788500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE SCHEMA IF NOT EXISTS farm`);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS farm.tenant_erasure_audit (
        "tenantId"           uuid PRIMARY KEY,
        "confirmedAt"        timestamptz NOT NULL,
        "requestedBy"        varchar(255) NOT NULL,
        "totalDeleted"       integer NOT NULL,
        "auditRowsAnonymised" integer NOT NULL,
        "tableCount"         integer NOT NULL,
        "deletedRowsByTable" jsonb NOT NULL DEFAULT '{}'::jsonb
      )
    `);

    // Defense-in-depth: trigger blocks UPDATEs on this table.
    // Same shape as the audit_logs immutability triggers (see
    // AUDITTRAIL-CRITICAL-001 / AUDITTRAIL-HIGH-005). Once a
    // tenant is erased, the audit row is the durable evidence —
    // no operator UPDATE or background job is allowed to mutate
    // it. DELETE is also forbidden (a tenant cannot be "un-erased"
    // and the row is the GDPR Art 17 controller-side evidence).
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION farm.tenant_erasure_audit_prevent_mutation()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'tenant_erasure_audit rows are immutable; tenantId=%, op=%',
          OLD."tenantId", TG_OP;
      END;
      $$ LANGUAGE plpgsql;
    `);
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS trg_tenant_erasure_audit_prevent_update
        ON farm.tenant_erasure_audit
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_tenant_erasure_audit_prevent_update
        BEFORE UPDATE OR DELETE ON farm.tenant_erasure_audit
        FOR EACH ROW
        EXECUTE FUNCTION farm.tenant_erasure_audit_prevent_mutation()
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS trg_tenant_erasure_audit_prevent_update ON farm.tenant_erasure_audit`,
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS farm.tenant_erasure_audit_prevent_mutation()`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS farm.tenant_erasure_audit`);
  }
}
