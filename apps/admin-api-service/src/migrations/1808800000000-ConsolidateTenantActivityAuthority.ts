import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Retires admin.tenant_activities as a second mutation ledger. Historical rows
 * are first preserved in the immutable admin audit stream; new activity is a
 * read projection of the source-owner auth command receipt ledger.
 */
export class ConsolidateTenantActivityAuthority1808800000000 implements MigrationInterface {
  name = 'ConsolidateTenantActivityAuthority1808800000000';
  transaction = true;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      INSERT INTO admin.audit_logs (
        id,
        action,
        "entityType",
        "entityId",
        "tenantId",
        "performedBy",
        "performedByEmail",
        details,
        "previousValue",
        "newValue",
        severity,
        "trustClass",
        provenance,
        "createdAt"
      )
      SELECT
        gen_random_uuid(),
        'LEGACY_TENANT_ACTIVITY_IMPORTED',
        'tenant',
        activity."tenantId",
        activity."tenantId",
        COALESCE(activity."performedBy", 'system:tenant-activity-consolidation'),
        activity."performedByEmail",
        jsonb_strip_nulls(
          jsonb_build_object(
            'legacyActivityId', activity.id,
            'legacyActivityType', activity."activityType"::text,
            'title', activity.title,
            'description', activity.description,
            'metadata', activity.metadata,
            'sourceAuthority', 'admin.tenant_activities'
          )
        ),
        activity."previousValue",
        activity."newValue",
        CASE
          WHEN activity."activityType"::text IN (
            'suspended', 'deactivated', 'user_removed', 'payment_failed', 'trial_expired'
          ) THEN 'warning'::admin.audit_logs_severity_enum
          ELSE 'info'::admin.audit_logs_severity_enum
        END,
        'LEGACY_UNVERIFIED'::admin.audit_logs_trustclass_enum,
        jsonb_build_object(
          'schemaVersion', 'admin-audit-legacy-provenance.v1',
          'sourceAuthority', 'admin.tenant_activities',
          'sourceRowId', activity.id::text,
          'sourceRowSha256', encode(
            public.digest(convert_to(to_jsonb(activity)::text, 'UTF8'), 'sha256'),
            'hex'
          )
        ),
        activity."createdAt"
      FROM admin.tenant_activities activity
    `);

    await queryRunner.query(`DROP TABLE admin.tenant_activities`);
    await queryRunner.query(`DROP TYPE IF EXISTS admin.tenant_activities_activitytype_enum`);
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // Forward-only authority consolidation; immutable evidence is never copied back.
  }
}
