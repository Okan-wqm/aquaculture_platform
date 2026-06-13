import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * DropTenantIsTrialActive1801000000000 (MT-MEDIUM-001)
 *
 * WHY: auth.tenants carried a denormalized `is_trial_active` boolean alongside
 * `trial_ends_at`. The two drifted (a tenant existed with is_trial_active=false
 * but a non-null trial_ends_at), and the entity's trial logic gated on the third
 * representation `plan = 'trial'` — which matched zero production rows, so every
 * real trial (a paid tier with trial_ends_at set) was silently reported as "not
 * on trial".
 *
 * The single source of truth is `trial_ends_at`: a tenant is on trial iff
 * trial_ends_at is set and in the future. `isTrialActive` is now a derived
 * getter (auth + admin-api read-replica), so the stored column is removed.
 *
 * BREAKING CHANGE: drops auth.tenants.is_trial_active. Consumers must derive
 * trial state from trial_ends_at (the entity getter does this).
 *
 * Idempotent (DROP COLUMN IF EXISTS) so a replay is a clean no-op. Blue-green
 * safe: the new revision stops writing the column (the entity field became a
 * getter) before this runs; the column is never read for correctness.
 */
export class DropTenantIsTrialActive1801000000000 implements MigrationInterface {
  name = 'DropTenantIsTrialActive1801000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // DESTRUCTIVE: drops auth.tenants.is_trial_active. Rollback = down() re-adds
    // it as boolean DEFAULT false; the value is NOT restored, but it was an
    // unmaintained denormalization of trial_ends_at, so no real state is lost.
    // Requires a pg_dump backup + ops stage-gate per the MT-MEDIUM-001 PR.
    await queryRunner.query(
      `ALTER TABLE "auth"."tenants" DROP COLUMN IF EXISTS "is_trial_active"`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "auth"."tenants" ADD COLUMN IF NOT EXISTS "is_trial_active" boolean NOT NULL DEFAULT false`,
    );
  }
}
