import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AddTenantSecurityLocalizationPolicy1807100000000 (ADR-045 —
 * ADMIN-HIGH-010 / ADMIN-MEDIUM-010)
 *
 * WHY: tenant MFA-enforcement and session-timeout policy previously existed
 * only as fabricated defaults synthesized by admin-api's retired
 * tenant-configuration adapter — a policy surface with zero enforcement.
 * ADR-045 makes auth-service the owner AND enforcer: the policy lives as
 * typed nullable columns on auth.tenants (the D14 tenant-record SSoT), read
 * by the login MFA-enforcement gate and the refresh-TTL clamp. The
 * localization preferences (timezone/date_format) are separate PREFERENCE
 * columns, deliberately not folded into a security container.
 *
 * Blue-green safe — nullable adds only. NULL = "no tenant policy set"
 * (platform defaults apply), so existing rows need no backfill and old code
 * that never selects the columns is unaffected.
 *
 * Idempotent via IF NOT EXISTS / IF EXISTS guards.
 *
 * Timestamp note: 1807000000000 is taken by sensor-service (db-migrate
 * aggregates all services), so this uses the next free repo-wide slot,
 * 1807100000000.
 */
export class AddTenantSecurityLocalizationPolicy1807100000000 implements MigrationInterface {
  name = 'AddTenantSecurityLocalizationPolicy1807100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "auth"."tenants" ADD COLUMN IF NOT EXISTS "enforce_mfa" boolean`,
    );
    await queryRunner.query(
      `ALTER TABLE "auth"."tenants" ADD COLUMN IF NOT EXISTS "session_timeout_minutes" integer`,
    );
    await queryRunner.query(
      `ALTER TABLE "auth"."tenants" ADD COLUMN IF NOT EXISTS "timezone" character varying(64)`,
    );
    await queryRunner.query(
      `ALTER TABLE "auth"."tenants" ADD COLUMN IF NOT EXISTS "date_format" character varying(10)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "auth"."tenants" DROP COLUMN IF EXISTS "date_format"`,
    );
    await queryRunner.query(
      `ALTER TABLE "auth"."tenants" DROP COLUMN IF EXISTS "timezone"`,
    );
    await queryRunner.query(
      `ALTER TABLE "auth"."tenants" DROP COLUMN IF EXISTS "session_timeout_minutes"`,
    );
    await queryRunner.query(
      `ALTER TABLE "auth"."tenants" DROP COLUMN IF EXISTS "enforce_mfa"`,
    );
  }
}
