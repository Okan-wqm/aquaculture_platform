import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AddPurchaseOrderApprovalAudit1801200000000
 *
 * # Why this migration exists (maker-checker approval gate — SOC2 CC3.4)
 *
 * The purchase-order maker-checker control records WHO approved a spend and WHEN.
 * `approved_by` (uuid) already existed; this migration adds the denormalized
 * approver display name (`approved_by_name`) captured at approval time so the
 * audit trail survives a later user rename/delete, and the immutable approval
 * timestamp (`approved_at`). Mirrors the inventory-count approval audit columns.
 *
 * # Schema routing
 *
 * `purchase_orders` is a per-tenant table in the tenant-scoped `farm` service, so
 * the migration uses UNQUALIFIED table names — the migration runner pins
 * search_path to `farm` then each `tenant_<uuid>` clone before invoking, and
 * unqualified names resolve to the current schema (no `schema:` prefix; ADR-011).
 *
 * # Blue-green safety
 *
 * Both columns are NULLABLE — old pods writing NULL during a rolling deploy do not
 * fail, so there is no nullable -> backfill -> NOT NULL dance and no SET NOT NULL.
 * `ADD COLUMN IF NOT EXISTS` makes the migration idempotent on replay.
 *
 * RLS already covers `purchase_orders` from the baseline (1800000000000), so this
 * migration does NOT re-assert applyTenantRlsToSchema — adding nullable columns
 * does not change the row-security posture.
 */
export class AddPurchaseOrderApprovalAudit1801200000000 implements MigrationInterface {
  name = 'AddPurchaseOrderApprovalAudit1801200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Lock-timeout envelope for the column-add DDL (bounded ACCESS EXCLUSIVE wait).
    // search_path is owned by the runner (session pin) — a migration-body
    // SET search_path is forbidden (sql-lint R4).
    await queryRunner.query(`SET LOCAL lock_timeout = '30s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '300s'`);

    await queryRunner.query(`
      ALTER TABLE purchase_orders
      ADD COLUMN IF NOT EXISTS "approved_by_name" character varying(255),
      ADD COLUMN IF NOT EXISTS "approved_at" TIMESTAMP WITH TIME ZONE
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE purchase_orders
      DROP COLUMN IF EXISTS "approved_at",
      DROP COLUMN IF EXISTS "approved_by_name"
    `);
  }
}
