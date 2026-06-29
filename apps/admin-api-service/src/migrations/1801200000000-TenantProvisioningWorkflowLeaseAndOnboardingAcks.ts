import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * TenantProvisioningWorkflowLeaseAndOnboardingAcks — forward completion of the
 * tenant-provisioning workflow surface (durable-worker lease columns, step
 * ordering, onboarding-ack ledger, run/tenant FK removal).
 * ============================================================================
 *
 * # WHY this exists (the incident)
 *
 * Migration `1800400000000-TenantProvisioningWorkflow` was hand-edited AFTER it
 * had already been recorded as applied on a deployed database (commit
 * `42695736f` edited the file created by `e147c9dfb`). TypeORM's
 * `MigrationExecutor` keys the ledger by migration NAME, so an already-recorded
 * migration is NEVER re-run — the edit's statements silently never landed on
 * that database. The deployed `admin.tenant_provisioning_runs` table was frozen
 * in its pre-edit shape; runtime code (built from the edited source) referenced
 * the missing `leaseToken`/`leaseExpiresAt` columns, so EVERY
 * `POST /api/v1/tenants` died with `QueryFailedError: column "leaseToken" does
 * not exist` → a redacted 500 "Database operation failed".
 *
 * This is the same "ledger says applied, DB says lagged" class the entity-diff
 * and migration-immutability gates close from other angles. CLAUDE.md: "Never
 * hand-edit migration files — generate a new one." So this is a NEW forward
 * migration that brings any database stuck at the pre-edit shape up to the
 * desired state; it is fully idempotent (IF NOT EXISTS / pg_constraint
 * existence-probe guards), so on a fresh database
 * — where 1800400000000 already created everything inline — every statement is a
 * no-op. Recurrence is closed by `tools/gates/migration-immutability-witness.ts`
 * (in-place edits of shipped migrations now fail CI).
 *
 * # Drift footprint repaired (authoritative — from the e147c9dfb→HEAD diff)
 *   ADD : leaseToken/leasedBy/heartbeatAt/leaseExpiresAt on tenant_provisioning_runs
 *   ADD : 'RESERVING' to the runs state CHECK
 *   ADD : idx_tenant_provisioning_runs_lease
 *   ADD : stepOrder on tenant_provisioning_steps + idx_tenant_provisioning_steps_run
 *   ADD : tenant_onboarding_acks table + index
 *   DROP: fk_tenant_provisioning_runs_tenant (run row is minted BEFORE the
 *         auth.tenants row exists — see below)
 *   GRANT: admin.* DML to admin_service
 *
 * # WHY the FK to auth.tenants is dropped
 *
 * The pre-edit CREATE TABLE declared
 *   CONSTRAINT fk_tenant_provisioning_runs_tenant FOREIGN KEY ("tenantId")
 *     REFERENCES auth.tenants(id) ON DELETE CASCADE
 * but `createTenantOperation` INSERTs the provisioning run with a freshly minted
 * `tenantId` BEFORE the `auth.tenants` row exists — that row is created later and
 * asynchronously by auth-service (`processOperation` → reserve_auth_tenant). With
 * the FK present the run INSERT fails with `23503` foreign_key_violation. The
 * edit removed the FK (run-before-tenant is the intended ordering); on the
 * drifted DB the FK survives, so this migration drops it.
 *
 * # WHY no auth.tenants REVOKE / no CREATE-ON-DATABASE revoke here
 *
 * The original edit also bundled privilege-TIGHTENING that never landed:
 * `REVOKE INSERT, UPDATE, DELETE ON auth.tenants FROM admin_service` (SEC-015
 * least-privilege) and the removal of `GRANT CREATE ON DATABASE … TO
 * admin_service`. Neither can be safely re-applied yet — admin-api still writes/
 * locks auth.tenants directly in its lifecycle handlers (suspend/activate/
 * deactivate/archive take FOR UPDATE on auth.tenants), so a REVOKE would swap
 * this 500 for a `permission denied for table tenants` 500. That least-privilege
 * restore is tracked as the capstone of making admin-api truly read-only on
 * auth (docs/reviews/orphan-findings.md ORPHAN-HIGH-214). This migration is
 * strictly additive (plus the FK drop) and touches only the admin schema's
 * grants.
 */
export class TenantProvisioningWorkflowLeaseAndOnboardingAcks1801200000000
  implements MigrationInterface
{
  name = 'TenantProvisioningWorkflowLeaseAndOnboardingAcks1801200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // --- drop the run→tenant FK: the run row is minted before auth.tenants ---
    await queryRunner.query(`
      ALTER TABLE "admin"."tenant_provisioning_runs"
        DROP CONSTRAINT IF EXISTS "fk_tenant_provisioning_runs_tenant"
    `);

    // --- tenant_provisioning_runs: lease columns (durable-worker lease) ---
    await queryRunner.query(`
      ALTER TABLE "admin"."tenant_provisioning_runs"
        ADD COLUMN IF NOT EXISTS "leaseToken" UUID NULL,
        ADD COLUMN IF NOT EXISTS "leasedBy" VARCHAR(128) NULL,
        ADD COLUMN IF NOT EXISTS "heartbeatAt" TIMESTAMPTZ NULL,
        ADD COLUMN IF NOT EXISTS "leaseExpiresAt" TIMESTAMPTZ NULL
    `);

    // --- tenant_provisioning_runs: state CHECK must allow RESERVING ---
    // PG has no `ADD CONSTRAINT IF NOT EXISTS`; guard the re-add with an explicit
    // pg_constraint existence probe rather than an EXCEPTION handler (an EXCEPTION
    // handler opens an implicit subtransaction — the silent-rollback class the
    // migration-integrity invariant forbids). DROP IF EXISTS then conditional ADD
    // is replay-safe with no subtransaction.
    await queryRunner.query(`
      DO $$
      BEGIN
        ALTER TABLE "admin"."tenant_provisioning_runs"
          DROP CONSTRAINT IF EXISTS "chk_tenant_provisioning_runs_state";
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'chk_tenant_provisioning_runs_state'
            AND conrelid = 'admin.tenant_provisioning_runs'::regclass
        ) THEN
          ALTER TABLE "admin"."tenant_provisioning_runs"
            ADD CONSTRAINT "chk_tenant_provisioning_runs_state"
              CHECK ("state" IN ('QUEUED', 'RESERVING', 'RUNNING', 'SUCCEEDED', 'FAILED'));
        END IF;
      END $$;
    `);

    // --- tenant_provisioning_runs: lease sweep index ---
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_tenant_provisioning_runs_lease"
        ON "admin"."tenant_provisioning_runs" ("state", "leaseExpiresAt")
    `);

    // --- tenant_provisioning_steps: stepOrder + run index ---
    await queryRunner.query(`
      ALTER TABLE "admin"."tenant_provisioning_steps"
        ADD COLUMN IF NOT EXISTS "stepOrder" INTEGER NOT NULL DEFAULT 999
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_tenant_provisioning_steps_run"
        ON "admin"."tenant_provisioning_steps" ("runId", "createdAt")
    `);

    // --- tenant_onboarding_acks: owner-service onboarding acknowledgements ---
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "admin"."tenant_onboarding_acks" (
        "id" UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        "operationId" UUID NOT NULL,
        "tenantId" UUID NOT NULL,
        "service" VARCHAR(128) NOT NULL,
        "status" VARCHAR(20) NOT NULL,
        "error" TEXT NULL,
        "acknowledgedAt" TIMESTAMPTZ NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "chk_tenant_onboarding_acks_status"
          CHECK ("status" IN ('ACK', 'FAILED')),
        CONSTRAINT "uk_tenant_onboarding_acks_operation_service"
          UNIQUE ("operationId", "service")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_tenant_onboarding_acks_operation"
        ON "admin"."tenant_onboarding_acks" ("operationId", "status")
    `);

    // --- admin_service DML grants on the provisioning ledger tables ---
    // Idempotent re-grant of ONLY the admin-schema privileges from the original
    // migration's grant block. The auth.tenants read-only REVOKE and the
    // CREATE-ON-DATABASE removal from that block are deliberately excluded here
    // (see the class docblock + ORPHAN-HIGH-214).
    await queryRunner.query(`
      DO $reconcile_admin_provisioning_grants$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'admin_service') THEN
          GRANT USAGE ON SCHEMA "admin" TO "admin_service";
          GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
            "admin"."tenant_provisioning_runs",
            "admin"."tenant_provisioning_steps",
            "admin"."tenant_onboarding_acks"
          TO "admin_service";
        END IF;
      END $reconcile_admin_provisioning_grants$;
    `);

    // Faithful mirror of 1800400000000's forensic marker.
    await queryRunner.query(`
      COMMENT ON TABLE "admin"."tenant_provisioning_runs" IS
        'grant_admin_service_tenant_provisioning_permissions'
    `);
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // Forward-only completion migration. The columns/tables/indexes are owned by
    // 1800400000000 (the desired end-state) and the dropped FK is intentionally
    // absent there; reverting would re-introduce the very drift this repairs.
    // Intentionally a no-op.
  }
}
