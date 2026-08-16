import { MigrationInterface, QueryRunner } from 'typeorm';
import {
  AUDIT_DELETE_AUTHORITY,
  auditImmutabilityStatements,
} from '@aquaculture/backend-common/database';
import { ADMIN_AUDIT_DATABASE_AUTHORITY } from '../audit/audit-database-authority';

/**
 * Preserves legacy activity/config rows as explicitly unverified historical
 * search material, then removes every duplicate audit writer and retention
 * mutation table. Data-protection retention is owned outside admin runtime.
 */
export class ConsolidateAdminActivityAuthority1808900000000 implements MigrationInterface {
  name = 'ConsolidateAdminActivityAuthority1808900000000';
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
        'LEGACY_ACTIVITY_IMPORTED',
        COALESCE(NULLIF(activity."entityType", ''), 'LegacyActivity'),
        CASE
          WHEN activity."entityId" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          THEN activity."entityId"::uuid
          ELSE NULL
        END,
        CASE
          WHEN activity."tenantId" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          THEN activity."tenantId"::uuid
          ELSE NULL
        END,
        COALESCE(NULLIF(activity."userId", ''), 'system:legacy-activity-consolidation'),
        activity."userEmail",
        jsonb_build_object(
          'legacyPayload', to_jsonb(activity) - 'previousValue' - 'newValue',
          'sourceAuthority', 'admin.activity_logs'
        ),
        activity."previousValue",
        activity."newValue",
        CASE
          WHEN activity.severity = 'critical' THEN 'critical'::admin.audit_logs_severity_enum
          WHEN activity.severity IN ('error', 'warning')
            THEN 'warning'::admin.audit_logs_severity_enum
          ELSE 'info'::admin.audit_logs_severity_enum
        END,
        'LEGACY_UNVERIFIED'::admin.audit_logs_trustclass_enum,
        jsonb_build_object(
          'schemaVersion', 'admin-audit-legacy-provenance.v1',
          'sourceAuthority', 'admin.activity_logs',
          'sourceRowId', activity.id::text,
          'sourceRowSha256', encode(
            public.digest(convert_to(to_jsonb(activity)::text, 'UTF8'), 'sha256'),
            'hex'
          )
        ),
        activity."createdAt"
      FROM admin.activity_logs activity
    `);

    await queryRunner.query(`
      INSERT INTO admin.audit_logs (
        id,
        action,
        "entityType",
        "entityId",
        "performedBy",
        details,
        severity,
        "trustClass",
        provenance,
        "createdAt"
      )
      SELECT
        gen_random_uuid(),
        'LEGACY_RETENTION_POLICY_IMPORTED',
        'LegacyRetentionPolicy',
        policy.id,
        COALESCE(NULLIF(policy."createdBy", ''), 'system:legacy-retention-consolidation'),
        jsonb_build_object(
          'legacyPayload', to_jsonb(policy),
          'sourceAuthority', 'admin.retention_policies'
        ),
        'info'::admin.audit_logs_severity_enum,
        'LEGACY_UNVERIFIED'::admin.audit_logs_trustclass_enum,
        jsonb_build_object(
          'schemaVersion', 'admin-audit-legacy-provenance.v1',
          'sourceAuthority', 'admin.retention_policies',
          'sourceRowId', policy.id::text,
          'sourceRowSha256', encode(
            public.digest(convert_to(to_jsonb(policy)::text, 'UTF8'), 'sha256'),
            'hex'
          )
        ),
        policy."createdAt"
      FROM admin.retention_policies policy
    `);

    await queryRunner.query(`DROP TABLE admin.activity_logs`);
    await queryRunner.query(`DROP TABLE admin.retention_policies`);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION admin.audit_logs_require_append_authority()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $authority$
      BEGIN
        IF current_setting(
          '${ADMIN_AUDIT_DATABASE_AUTHORITY.appendContextSetting}',
          true
        ) IS DISTINCT FROM '${ADMIN_AUDIT_DATABASE_AUTHORITY.appendContextValue}' THEN
          RAISE EXCEPTION 'admin.audit_logs INSERT requires canonical append authority';
        END IF;
        IF current_user IS DISTINCT FROM pg_catalog.pg_get_userbyid(
          (
            SELECT procedure.proowner
            FROM pg_catalog.pg_proc procedure
            WHERE procedure.oid = pg_catalog.to_regprocedure(
              '${ADMIN_AUDIT_DATABASE_AUTHORITY.appendFunctionIdentity}'
            )
          )
        ) THEN
          RAISE EXCEPTION 'admin.audit_logs INSERT requires canonical append function owner';
        END IF;
        IF NEW."trustClass" IS DISTINCT FROM 'AUTHORITATIVE_RUNTIME'
           OR NEW.provenance IS NOT NULL THEN
          RAISE EXCEPTION 'canonical append authority may only create authoritative runtime evidence';
        END IF;
        RETURN NEW;
      END
      $authority$
    `);
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS trg_audit_logs_require_append_authority
      ON admin.audit_logs
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_audit_logs_require_append_authority
      BEFORE INSERT ON admin.audit_logs
      FOR EACH ROW
      EXECUTE FUNCTION admin.audit_logs_require_append_authority()
    `);
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION ${ADMIN_AUDIT_DATABASE_AUTHORITY.appendFunction}(
        p_action varchar,
        p_entity_type varchar,
        p_entity_id uuid,
        p_tenant_id uuid,
        p_performed_by varchar,
        p_performed_by_email varchar,
        p_ip_address inet,
        p_user_agent varchar,
        p_details jsonb,
        p_previous_value jsonb,
        p_new_value jsonb,
        p_severity admin.audit_logs_severity_enum,
        p_request_id varchar,
        p_session_id varchar
      )
      RETURNS admin.audit_logs
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = pg_catalog, admin
      AS $append$
      DECLARE
        appended admin.audit_logs;
      BEGIN
        PERFORM pg_catalog.set_config(
          '${ADMIN_AUDIT_DATABASE_AUTHORITY.appendContextSetting}',
          '${ADMIN_AUDIT_DATABASE_AUTHORITY.appendContextValue}',
          true
        );
        INSERT INTO admin.audit_logs (
          action,
          "entityType",
          "entityId",
          "tenantId",
          "performedBy",
          "performedByEmail",
          "ipAddress",
          "userAgent",
          details,
          "previousValue",
          "newValue",
          severity,
          "trustClass",
          provenance,
          "requestId",
          "sessionId"
        ) VALUES (
          p_action,
          p_entity_type,
          p_entity_id,
          p_tenant_id,
          p_performed_by,
          p_performed_by_email,
          p_ip_address,
          p_user_agent,
          p_details,
          p_previous_value,
          p_new_value,
          p_severity,
          'AUTHORITATIVE_RUNTIME',
          NULL,
          p_request_id,
          p_session_id
        )
        RETURNING * INTO appended;
        RETURN appended;
      END
      $append$
    `);
    await queryRunner.query(`
      REVOKE ALL ON FUNCTION ${ADMIN_AUDIT_DATABASE_AUTHORITY.appendFunctionIdentity}
      FROM PUBLIC
    `);
    await queryRunner.query(`REVOKE INSERT, UPDATE, DELETE ON admin.audit_logs FROM PUBLIC`);
    await queryRunner.query(`
      DO $privilege$
      BEGIN
        IF to_regrole('${ADMIN_AUDIT_DATABASE_AUTHORITY.runtimeRole}') IS NOT NULL THEN
          REVOKE INSERT, UPDATE, DELETE ON admin.audit_logs
            FROM admin_service;
          GRANT EXECUTE ON FUNCTION ${ADMIN_AUDIT_DATABASE_AUTHORITY.appendFunctionIdentity}
          TO admin_service;
        END IF;
      END
      $privilege$
    `);

    // No application provider or route owns audit deletion. Direct table
    // mutation is revoked from the runtime role and the database trigger admits
    // DELETE only after a caller has assumed the dedicated controller role.
    for (const statement of auditImmutabilityStatements(
      { schema: 'admin', table: 'audit_logs' },
      {
        deleteAuthority: AUDIT_DELETE_AUTHORITY.DEDICATED_RETENTION_CONTROLLER,
        retentionControllerRole: ADMIN_AUDIT_DATABASE_AUTHORITY.retentionControllerRole,
        revokeMutationFromRoles: [ADMIN_AUDIT_DATABASE_AUTHORITY.runtimeRole],
      },
    )) {
      await queryRunner.query(statement);
    }
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // Forward-only authority consolidation; historical evidence is never demoted.
  }
}
