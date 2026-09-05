import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * RetireMfaEnabledSetting — `security.mfa_enabled` leaves admin.system_settings
 * (ADR-0011, SEC-CRITICAL-058).
 *
 * WHY: the key was seeded as "Enable MFA support platform-wide", shown as a
 * toggle on the System Settings page, and read by nothing that enforces
 * anything — a documented off-switch for a compliance control that never
 * existed. MFA for platform admins is minted in auth-service and verified in
 * the kernel; its single switch is SUPER_ADMIN_MFA_ENFORCED_AT, reviewed in
 * git, not a row an operator can flip.
 *
 * Row DML on a configuration table — the setting carried no evidence value,
 * so it is deleted rather than archived.
 */
export class RetireMfaEnabledSetting1808700000000 implements MigrationInterface {
  name = 'RetireMfaEnabledSetting1808700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'admin' AND table_name = 'system_settings'
        ) THEN
          DELETE FROM "admin"."system_settings" WHERE "key" = 'security.mfa_enabled';
        END IF;
      END $$;
    `);
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // Forward-only: reinstating the key would reinstate an off-switch for a
    // mandatory control (ADR-0011).
  }
}
