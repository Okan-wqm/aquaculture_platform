import { MigrationInterface, QueryRunner } from 'typeorm';

export class BackfillTenantProvisioningTopologyAuth1800500000000 implements MigrationInterface {
  name = 'BackfillTenantProvisioningTopologyAuth1800500000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      DECLARE
        tenant_rec RECORD;
      BEGIN
        IF to_regclass('"admin"."tenant_schemas"') IS NULL THEN
          RETURN;
        END IF;

        FOR tenant_rec IN
          SELECT ts."tenantId" AS tenant_id, ts."schemaName" AS schema_name
          FROM "admin"."tenant_schemas" ts
          JOIN "auth"."tenants" t ON t.id = ts."tenantId"
          WHERE COALESCE(ts.status, 'active') <> 'deleted'
        LOOP
          IF to_regclass(format('%I.%I', tenant_rec.schema_name, 'tenant_roles')) IS NOT NULL THEN
            EXECUTE format(
              'INSERT INTO "auth"."tenant_roles" (
                 id, "tenantId", code, name, description, permissions, color, icon,
                 level, is_system, is_default, is_editable, display_order,
                 created_by, created_at, updated_at
               )
               SELECT
                 r.id,
                 COALESCE(r."tenantId", $1),
                 r.code,
                 r.name,
                 r.description,
                 COALESCE(r.permissions, ''[]''::jsonb),
                 COALESCE(r.color, ''#6366F1''),
                 COALESCE(r.icon, ''shield''),
                 COALESCE(r.level, 50),
                 COALESCE(r.is_system, false),
                 COALESCE(r.is_default, false),
                 COALESCE(r.is_editable, true),
                 COALESCE(r.display_order, 0),
                 r.created_by,
                 COALESCE(r.created_at, now()),
                 COALESCE(r.updated_at, now())
               FROM %I.%I r
               WHERE NOT EXISTS (
                 SELECT 1 FROM "auth"."tenant_roles" ar WHERE ar.id = r.id
               )',
              tenant_rec.schema_name,
              'tenant_roles'
            )
            USING tenant_rec.tenant_id;
          END IF;

          IF to_regclass(format('%I.%I', tenant_rec.schema_name, 'tenant_role_permissions')) IS NOT NULL THEN
            EXECUTE format(
              'INSERT INTO "auth"."tenant_role_permissions" (
                 id, role_id, panel_permissions, resource_permissions, created_at, updated_at
               )
               SELECT
                 p.id,
                 p.role_id,
                 COALESCE(p.panel_permissions, ''{}''::jsonb),
                 COALESCE(p.resource_permissions, ARRAY[]::text[]),
                 COALESCE(p.created_at, now()),
                 COALESCE(p.updated_at, now())
               FROM %I.%I p
               JOIN "auth"."tenant_roles" r ON r.id = p.role_id AND r."tenantId" = $1
               WHERE NOT EXISTS (
                 SELECT 1 FROM "auth"."tenant_role_permissions" ap WHERE ap.id = p.id
               )',
              tenant_rec.schema_name,
              'tenant_role_permissions'
            )
            USING tenant_rec.tenant_id;
          END IF;

          IF to_regclass(format('%I.%I', tenant_rec.schema_name, 'user_role_assignments')) IS NOT NULL THEN
            EXECUTE format(
              'INSERT INTO "auth"."user_role_assignments" (
                 id, user_id, role_id, permission_overrides, assigned_by,
                 assigned_at, expires_at, is_active, created_at, updated_at
               )
               SELECT
                 a.id,
                 a.user_id,
                 a.role_id,
                 COALESCE(a.permission_overrides, ''{"grants":[],"revokes":[]}''::jsonb),
                 a.assigned_by,
                 COALESCE(a.assigned_at, now()),
                 a.expires_at,
                 COALESCE(a.is_active, true),
                 COALESCE(a.created_at, now()),
                 COALESCE(a.updated_at, now())
               FROM %I.%I a
               JOIN "auth"."tenant_roles" r ON r.id = a.role_id AND r."tenantId" = $1
               WHERE NOT EXISTS (
                 SELECT 1 FROM "auth"."user_role_assignments" aa WHERE aa.id = a.id
               )
                 AND NOT EXISTS (
                   SELECT 1 FROM "auth"."user_role_assignments" au WHERE au.user_id = a.user_id
                 )',
              tenant_rec.schema_name,
              'user_role_assignments'
            )
            USING tenant_rec.tenant_id;
          END IF;
        END LOOP;
      END $$;
    `);
  }

  async down(_queryRunner: QueryRunner): Promise<void> {
    // Data backfill is intentionally not reversed.
  }
}
