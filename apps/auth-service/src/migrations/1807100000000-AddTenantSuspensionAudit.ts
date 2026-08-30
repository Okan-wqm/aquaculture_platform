import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AddTenantSuspensionAudit1807100000000 (DB-ADMIN-HIGH-003 / ORPHAN-HIGH-360)
 *
 * WHY: the admin tenant-lifecycle handlers have been assigning
 * suspendedAt / suspendedReason / suspendedBy on every suspension, but those
 * properties were declared as NON-persisted compatibility props on admin's
 * read-view entity (no @Column) — TypeORM silently dropped them, so the
 * platform had NO durable record of WHEN a tenant was suspended, WHY, or BY
 * WHOM. The columns belong on auth.tenants because auth-service is the
 * single writer of the tenant row (DB-ADMIN-HIGH-004): the SUSPENDED
 * transition in TenantProvisioningCommandService.transitionTenantStatus now
 * persists the trio atomically with the status write, and the ACTIVE
 * transition clears it.
 *
 * Blue-green safe — SINGLE step: all three columns are NULLABLE with no
 * default. NULL is the truthful value for every existing row ("not suspended,
 * or suspended before this audit existed"); no backfill or NOT NULL follow-up
 * is required because the suspension audit is intrinsically optional.
 *
 * Idempotent via IF NOT EXISTS / IF EXISTS guards.
 *
 * Timestamp note: db-migrate aggregates all services' migrations into one
 * ordered stream; 1807000000000 (sensor VFD audit log) was the repo-wide max,
 * so this takes the next free slot, 1807100000000.
 */
export class AddTenantSuspensionAudit1807100000000 implements MigrationInterface {
  name = 'AddTenantSuspensionAudit1807100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "auth"."tenants" ADD COLUMN IF NOT EXISTS "suspendedAt" timestamptz`,
    );
    await queryRunner.query(
      `ALTER TABLE "auth"."tenants" ADD COLUMN IF NOT EXISTS "suspendedReason" text`,
    );
    await queryRunner.query(
      `ALTER TABLE "auth"."tenants" ADD COLUMN IF NOT EXISTS "suspendedBy" uuid`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "auth"."tenants" DROP COLUMN IF EXISTS "suspendedBy"`);
    await queryRunner.query(`ALTER TABLE "auth"."tenants" DROP COLUMN IF EXISTS "suspendedReason"`);
    await queryRunner.query(`ALTER TABLE "auth"."tenants" DROP COLUMN IF EXISTS "suspendedAt"`);
  }
}
