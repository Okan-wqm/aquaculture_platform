import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AddTenantAuthSecurityPolicy1819000000000 (ADR-046 — ADMIN-HIGH-010 /
 * ADMIN-HIGH-014 / ADMIN-HIGH-015)
 *
 * WHY: tenant MFA-enforcement and idle-session-timeout policy previously
 * existed only as fabricated defaults synthesized by admin-api's retired
 * tenant-configuration adapter — a policy surface with zero enforcement.
 * ADR-046 makes auth-service the owner AND enforcer: the policy lives as
 * typed nullable columns on `auth.tenants` (the D14 tenant-record SSoT), read
 * by the login MFA-enrollment gate and by the refresh-TTL clamp inside
 * `TokenService.generateTokens`.
 *
 * SCOPE: security policy ONLY. Tenant localization (timezone / locale) is a
 * DIFFERENT authority and is deliberately NOT added here — it is owned by the
 * `auth.tenants.settings.localization` surface written through the tenant
 * command-receipt path (`updateTenantLocalization` + the `TenantUpdated`
 * outbox emission). Two competing timezone columns would be exactly the
 * split-brain this migration's own ADR forbids.
 *
 * Blue-green safe — nullable adds only. NULL = "no tenant policy set"
 * (platform defaults apply), so existing rows need no backfill and older
 * replicas that never select the columns are unaffected.
 *
 * Idempotent via IF NOT EXISTS / IF EXISTS guards.
 */
export class AddTenantAuthSecurityPolicy1819000000000 implements MigrationInterface {
  name = 'AddTenantAuthSecurityPolicy1819000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "auth"."tenants" ADD COLUMN IF NOT EXISTS "enforce_mfa" boolean`,
    );
    await queryRunner.query(
      `ALTER TABLE "auth"."tenants" ADD COLUMN IF NOT EXISTS "session_timeout_minutes" integer`,
    );
    // The 5..1440 bound is validated at the mutation DTO; the CHECK makes the
    // same bound a property of the STORE, so no future writer (a repair
    // script, a data fix, a second service) can persist a value the token
    // clamp would treat as a near-instant logout or a non-idle timeout.
    // Mirrored by the matching @Check() on the Tenant entity so the
    // schema-drift validator's Class-G constraint count stays balanced.
    // PostgreSQL has no ADD CONSTRAINT IF NOT EXISTS — guard on pg_constraint.
    await queryRunner.query(
      `DO $$
       BEGIN
         IF NOT EXISTS (
           SELECT 1 FROM pg_constraint
           WHERE conname = 'CHK_tenants_session_timeout_minutes_range'
             AND conrelid = 'auth.tenants'::regclass
         ) THEN
           ALTER TABLE "auth"."tenants"
             ADD CONSTRAINT "CHK_tenants_session_timeout_minutes_range"
             CHECK ("session_timeout_minutes" IS NULL
                    OR ("session_timeout_minutes" >= 5 AND "session_timeout_minutes" <= 1440));
         END IF;
       END $$;`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "auth"."tenants" DROP CONSTRAINT IF EXISTS "CHK_tenants_session_timeout_minutes_range"`,
    );
    await queryRunner.query(
      `ALTER TABLE "auth"."tenants" DROP COLUMN IF EXISTS "session_timeout_minutes"`,
    );
    await queryRunner.query(`ALTER TABLE "auth"."tenants" DROP COLUMN IF EXISTS "enforce_mfa"`);
  }
}
