import { applyTenantRlsToSchema } from '@aquaculture/backend-common/database';
import { MigrationInterface, QueryRunner } from 'typeorm';

const TENANT_SCHEMA_REGEX = /^tenant_[a-f0-9]{16}$/;

const TOPOLOGY_SOURCE_SCHEMAS = [
  'sensor',
  'farm',
  'hr',
  'hydroponics',
  'alert',
  'ai',
  'messaging',
] as const;

const TOPOLOGY_SOURCE_ONLY_TABLES = [
  'migrations',
  'sensor_audit_logs',
  'farm_outbox',
  'tenant_erasure_audit',
  'farm_audit_logs',
  'hr_outbox',
  'payroll_audit',
  'alert_audit_log',
  'ai_outbox',
  'tool_execution_audit',
  'messaging_outbox',
  'embeddings_metadata',
] as const;

const TENANT_TOPOLOGY_RLS_COLUMNS = ['tenantId', 'tenant_id'] as const;

interface TenantSchemaRow {
  schema_name: string;
}

interface TopologyTableRow {
  table_name: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isTenantSchemaRow(value: unknown): value is TenantSchemaRow {
  return isRecord(value) && typeof value.schema_name === 'string';
}

function isTopologyTableRow(value: unknown): value is TopologyTableRow {
  return isRecord(value) && typeof value.table_name === 'string';
}

async function queryRows<T>(
  queryRunner: QueryRunner,
  sql: string,
  params: readonly unknown[],
  guard: (value: unknown) => value is T,
): Promise<T[]> {
  const result: unknown = await queryRunner.query(sql, [...params]);
  if (!Array.isArray(result)) {
    return [];
  }
  return result.filter(guard);
}

function assertTenantSchemaName(schemaName: string): void {
  if (!TENANT_SCHEMA_REGEX.test(schemaName)) {
    throw new Error(
      `Unsafe tenant schema name discovered during admin topology migration: ${schemaName}`,
    );
  }
}

async function discoverActiveTenantSchemas(
  queryRunner: QueryRunner,
): Promise<string[]> {
  const rows = await queryRows(
    queryRunner,
    `
      SELECT ts."schemaName" AS schema_name
      FROM "admin"."tenant_schemas" ts
      JOIN "auth"."tenants" t ON t.id = ts."tenantId"
      WHERE ts."schemaName" ~ '^tenant_[a-f0-9]{16}$'
        AND COALESCE(ts.status, 'active') <> 'deleted'
      ORDER BY ts."schemaName"
    `,
    [],
    isTenantSchemaRow,
  );

  const schemaNames = [...new Set(rows.map((row) => row.schema_name))];
  for (const schemaName of schemaNames) {
    assertTenantSchemaName(schemaName);
  }
  return schemaNames;
}

async function discoverTopologyTableNames(
  queryRunner: QueryRunner,
): Promise<string[]> {
  const rows = await queryRows(
    queryRunner,
    `
      SELECT DISTINCT t.table_name
      FROM information_schema.tables t
      WHERE t.table_schema = ANY($1::text[])
        AND t.table_type = 'BASE TABLE'
        AND t.table_name <> ALL($2::text[])
      ORDER BY t.table_name
    `,
    [[...TOPOLOGY_SOURCE_SCHEMAS], [...TOPOLOGY_SOURCE_ONLY_TABLES]],
    isTopologyTableRow,
  );

  const tableNames = rows.map((row) => row.table_name);
  if (tableNames.length === 0) {
    throw new Error(
      'Admin tenant topology migration discovered no source tables for tenant RLS convergence',
    );
  }
  return tableNames;
}

export class TenantProvisioningTopology1800500000000
  implements MigrationInterface
{
  name = 'TenantProvisioningTopology1800500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $tenant_provisioning_topology$
      DECLARE
        tenant_rec RECORD;
        source_schema TEXT;
        service_role TEXT;
        table_rec RECORD;
        source_schemas TEXT[] := ARRAY[
          'sensor',
          'farm',
          'hr',
          'hydroponics',
          'alert',
          'ai',
          'messaging'
        ];
        source_only_tables TEXT[] := ARRAY[
          'migrations',
          'sensor_audit_logs',
          'farm_outbox',
          'tenant_erasure_audit',
          'farm_audit_logs',
          'hr_outbox',
          'payroll_audit',
          'alert_audit_log',
          'ai_outbox',
          'tool_execution_audit',
          'messaging_outbox',
          'embeddings_metadata'
        ];
      BEGIN
        IF to_regclass('"admin"."tenant_schemas"') IS NULL THEN
          RAISE EXCEPTION 'admin.tenant_schemas is required before tenant topology fan-out can run';
        END IF;

        IF EXISTS (
          SELECT 1
          FROM pg_namespace n
          WHERE n.nspname ~ '^tenant_[a-f0-9]{16}$'
            AND NOT EXISTS (
              SELECT 1
              FROM "admin"."tenant_schemas" ts
              WHERE ts."schemaName" = n.nspname
            )
        ) THEN
          RAISE EXCEPTION 'Untracked tenant schemas exist; register them in admin.tenant_schemas before topology fan-out';
        END IF;

        FOR tenant_rec IN
          SELECT ts."tenantId"::uuid AS tenant_id, ts."schemaName" AS schema_name
          FROM "admin"."tenant_schemas" ts
          JOIN "auth"."tenants" t ON t.id = ts."tenantId"
          WHERE ts."schemaName" ~ '^tenant_[a-f0-9]{16}$'
            AND COALESCE(ts.status, 'active') <> 'deleted'
        LOOP
          FOREACH source_schema IN ARRAY source_schemas LOOP
            service_role := source_schema || '_service';

            FOR table_rec IN
              SELECT table_name
              FROM information_schema.tables
              WHERE table_schema = source_schema
                AND table_type = 'BASE TABLE'
                AND table_name <> ALL(source_only_tables)
              ORDER BY table_name
            LOOP
              IF to_regclass(format('%I.%I', tenant_rec.schema_name, table_rec.table_name)) IS NULL THEN
                EXECUTE format(
                  'CREATE TABLE %I.%I (LIKE %I.%I INCLUDING ALL)',
                  tenant_rec.schema_name,
                  table_rec.table_name,
                  source_schema,
                  table_rec.table_name
                );
              END IF;

              IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = service_role) THEN
                EXECUTE format('GRANT USAGE ON SCHEMA %I TO %I', tenant_rec.schema_name, service_role);
                EXECUTE format(
                  'GRANT ALL PRIVILEGES ON TABLE %I.%I TO %I',
                  tenant_rec.schema_name,
                  table_rec.table_name,
                  service_role
                );
                EXECUTE format(
                  'GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA %I TO %I',
                  tenant_rec.schema_name,
                  service_role
                );
              END IF;
            END LOOP;
          END LOOP;

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

          EXECUTE format('DROP TABLE IF EXISTS %I.%I CASCADE', tenant_rec.schema_name, 'user_role_assignments');
          EXECUTE format('DROP TABLE IF EXISTS %I.%I CASCADE', tenant_rec.schema_name, 'tenant_role_permissions');
          EXECUTE format('DROP TABLE IF EXISTS %I.%I CASCADE', tenant_rec.schema_name, 'tenant_roles');
        END LOOP;
      END $tenant_provisioning_topology$;
    `);

    await this.applyTenantTopologyRls(queryRunner);

    await queryRunner.query(`
      DO $tenant_provisioning_topology_post$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM information_schema.tables t
          WHERE t.table_schema ~ '^tenant_[a-f0-9]{16}$'
            AND t.table_name IN (
              'tenant_roles',
              'tenant_role_permissions',
              'user_role_assignments'
            )
        ) THEN
          RAISE EXCEPTION 'Tenant auth-role clone tables remain after topology migration';
        END IF;
      END $tenant_provisioning_topology_post$;
    `);
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // Forward-only topology convergence; recreating tenant auth clones would
    // reintroduce the platform/tenant trust-boundary violation this removes.
  }

  private async applyTenantTopologyRls(queryRunner: QueryRunner): Promise<void> {
    const [tenantSchemas, topologyTables] = await Promise.all([
      discoverActiveTenantSchemas(queryRunner),
      discoverTopologyTableNames(queryRunner),
    ]);

    for (const schemaName of tenantSchemas) {
      await applyTenantRlsToSchema(queryRunner, {
        schemaOverride: schemaName,
        includeTables: topologyTables,
        tenantIdColumns: TENANT_TOPOLOGY_RLS_COLUMNS,
      });
    }
  }
}
