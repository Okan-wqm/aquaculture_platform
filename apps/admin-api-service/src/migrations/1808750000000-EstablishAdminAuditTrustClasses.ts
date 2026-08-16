import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Separates authoritative runtime evidence from searchable historical imports.
 * The database constraint, not caller convention, owns the trust boundary.
 */
export class EstablishAdminAuditTrustClasses1808750000000 implements MigrationInterface {
  name = 'EstablishAdminAuditTrustClasses1808750000000';
  transaction = true;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF to_regprocedure('public.digest(bytea,text)') IS NULL THEN
          RAISE EXCEPTION 'pgcrypto digest(bytea,text) is required for legacy audit provenance';
        END IF;
      END
      $$
    `);

    await queryRunner.query(`
      CREATE TYPE admin.audit_logs_trustclass_enum AS ENUM (
        'AUTHORITATIVE_RUNTIME',
        'LEGACY_UNVERIFIED'
      )
    `);

    await queryRunner.query(`
      ALTER TABLE admin.audit_logs
        ADD COLUMN "trustClass" admin.audit_logs_trustclass_enum,
        ADD COLUMN provenance jsonb
    `);

    // The trust class did not exist when these rows were written. Preserve
    // their original action for search, but never promote them into qualified
    // runtime evidence. The update trigger is suspended only inside this
    // exception-safe classification block and is re-enabled on every path.
    await queryRunner.query(`
      DO $classification$
      BEGIN
        EXECUTE 'ALTER TABLE admin.audit_logs DISABLE TRIGGER trg_audit_logs_prevent_update';
        BEGIN
          UPDATE admin.audit_logs AS audit
          SET
            "trustClass" = 'LEGACY_UNVERIFIED',
            provenance = jsonb_build_object(
              'schemaVersion', 'admin-audit-legacy-provenance.v1',
              'sourceAuthority', 'admin.audit_logs.pretrust',
              'sourceRowId', audit.id::text,
              'sourceRowSha256', encode(
                public.digest(
                  convert_to(
                    (to_jsonb(audit) - 'trustClass' - 'provenance')::text,
                    'UTF8'
                  ),
                  'sha256'
                ),
                'hex'
              ),
              'sourceAction', audit.action
            )
          WHERE audit."trustClass" IS NULL;
        EXCEPTION WHEN OTHERS THEN
          EXECUTE 'ALTER TABLE admin.audit_logs ENABLE TRIGGER trg_audit_logs_prevent_update';
          RAISE;
        END;
        EXECUTE 'ALTER TABLE admin.audit_logs ENABLE TRIGGER trg_audit_logs_prevent_update';
      END
      $classification$
    `);

    await queryRunner.query(`
      ALTER TABLE admin.audit_logs
        ALTER COLUMN "trustClass" SET DEFAULT 'AUTHORITATIVE_RUNTIME',
        ALTER COLUMN "trustClass" SET NOT NULL
    `);

    await queryRunner.query(`
      ALTER TABLE admin.audit_logs
        ADD CONSTRAINT "CHK_admin_audit_logs_trust_provenance"
        CHECK ((
          (
            "trustClass" = 'AUTHORITATIVE_RUNTIME'
            AND provenance IS NULL
            AND action NOT IN (
              'LEGACY_ACTIVITY_IMPORTED',
              'LEGACY_TENANT_ACTIVITY_IMPORTED',
              'LEGACY_RETENTION_POLICY_IMPORTED'
            )
          )
          OR
          (
            "trustClass" = 'LEGACY_UNVERIFIED'
            AND provenance IS NOT NULL
            AND jsonb_typeof(provenance) = 'object'
            AND provenance->>'schemaVersion' = 'admin-audit-legacy-provenance.v1'
            AND length(provenance->>'sourceRowId') > 0
            AND provenance->>'sourceRowSha256' ~ '^[a-f0-9]{64}$'
            AND (
              (
                provenance->>'sourceAuthority' = 'admin.audit_logs.pretrust'
                AND provenance->>'sourceRowId' = id::text
                AND provenance->>'sourceAction' = action
              )
              OR
              (
                action = 'LEGACY_ACTIVITY_IMPORTED'
                AND provenance->>'sourceAuthority' = 'admin.activity_logs'
                AND NOT (provenance ? 'sourceAction')
              )
              OR
              (
                action = 'LEGACY_TENANT_ACTIVITY_IMPORTED'
                AND provenance->>'sourceAuthority' = 'admin.tenant_activities'
                AND NOT (provenance ? 'sourceAction')
              )
              OR
              (
                action = 'LEGACY_RETENTION_POLICY_IMPORTED'
                AND provenance->>'sourceAuthority' = 'admin.retention_policies'
                AND NOT (provenance ? 'sourceAction')
              )
            )
          )
        ) IS TRUE)
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_admin_audit_logs_trust_created_at"
      ON admin.audit_logs ("trustClass", "createdAt")
    `);
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // Forward-only evidence classification. Later imports depend on this boundary.
  }
}
