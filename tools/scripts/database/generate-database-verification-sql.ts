#!/usr/bin/env ts-node

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  bootstrapCreatedSchemas,
  migrationRunnerSchemas,
  tenantAwareSchemas,
} from '../../../platform/libs/service-catalog/src/topology';

export interface SentinelDefinition {
  readonly schema: string;
  readonly table: string;
}

export interface TenantSentinelDefinition {
  readonly sourceSchema: string;
  readonly table: string;
}

export const GLOBAL_SENTINELS = [
  { schema: 'auth', table: 'tenants' },
  { schema: 'auth', table: 'users' },
  { schema: 'billing', table: 'subscriptions' },
] as const satisfies readonly SentinelDefinition[];

export const TENANT_SENTINELS = [
  { sourceSchema: 'farm', table: 'farms' },
  { sourceSchema: 'sensor', table: 'sensors' },
  { sourceSchema: 'hr', table: 'employees' },
  { sourceSchema: 'messaging', table: 'channels' },
  { sourceSchema: 'hydroponics', table: 'hydroponics_config' },
  { sourceSchema: 'alert', table: 'alert_rules' },
  { sourceSchema: 'ai', table: 'agent_conversations' },
] as const satisfies readonly TenantSentinelDefinition[];

const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const OUTPUT_PATH = resolve(REPO_ROOT, 'tools/scripts/database/database-verification.sql');
const PITR_LOCK_OUTPUT_PATH = resolve(
  REPO_ROOT,
  'tools/scripts/database/pitr-source-verification-locks.sql',
);

function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function textArray(values: readonly string[]): string {
  return `ARRAY[${values.map(sqlLiteral).join(', ')}]::text[]`;
}

function globalSentinelValues(): string {
  return GLOBAL_SENTINELS.map(
    (sentinel, index) =>
      `(${index + 1}, ${sqlLiteral(sentinel.schema)}, ${sqlLiteral(sentinel.table)})`,
  ).join(',\n        ');
}

function tenantSentinelValues(): string {
  return TENANT_SENTINELS.map(
    (sentinel, index) =>
      `(${index + 1}, ${sqlLiteral(sentinel.sourceSchema)}, ${sqlLiteral(sentinel.table)})`,
  ).join(',\n          ');
}

function renderDatabaseVerificationBody(finalStatement: string): string {
  const canonicalSchemas = bootstrapCreatedSchemas();
  const sourceSchemas = migrationRunnerSchemas();
  const tenantSchemas = tenantAwareSchemas();

  if (canonicalSchemas.length !== 17) {
    throw new Error(`Expected 17 bootstrap-created schemas, found ${canonicalSchemas.length}`);
  }
  if (sourceSchemas.length !== 14) {
    throw new Error(`Expected 14 migration-runner schemas, found ${sourceSchemas.length}`);
  }
  if (tenantSchemas.length !== TENANT_SENTINELS.length) {
    throw new Error(
      `Tenant sentinel count ${TENANT_SENTINELS.length} does not match topology ${tenantSchemas.length}`,
    );
  }
  if (TENANT_SENTINELS.some((sentinel, index) => sentinel.sourceSchema !== tenantSchemas[index])) {
    throw new Error('Tenant sentinel order must match tenantAwareSchemas()');
  }

  return `DECLARE
  canonical_schemas constant text[] := ${textArray(canonicalSchemas)};
  source_schemas constant text[] := ${textArray(sourceSchemas)};
  tenant_aware_schemas constant text[] := ${textArray(tenantSchemas)};
  required_schema text;
  source_schema text;
  tenant_schema text;
  malformed_tenant_schemas text;
  tenant_registry_mapping_drift text;
  tenant_registry_collisions text;
  tenant_registry_namespace_drift text;
  release_row record;
  actual_timestamp text;
  actual_name text;
  expected_timestamp text;
  expected_name text;
  ledger_table text;
  sentinel record;
  sentinel_count bigint;
  sentinel_checksum text;
  source_ordinal integer;
  tenant_schema_names jsonb := '[]'::jsonb;
  schema_heads jsonb := '[]'::jsonb;
  tenant_heads jsonb := '[]'::jsonb;
  sentinel_proofs jsonb := '[]'::jsonb;
  verification_payload jsonb;
BEGIN
  FOREACH required_schema IN ARRAY canonical_schemas LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = required_schema) THEN
      RAISE EXCEPTION 'Required schema % is missing from the restored database', required_schema;
    END IF;
  END LOOP;

  IF to_regclass('platform.release_ledger') IS NULL THEN
    RAISE EXCEPTION 'Required relation platform.release_ledger is missing from the restored database';
  END IF;

  SELECT string_agg(nspname, ', ' ORDER BY nspname)
    INTO malformed_tenant_schemas
    FROM pg_namespace
   WHERE nspname LIKE 'tenant\\_%' ESCAPE '\\'
     AND nspname !~ '^tenant_[a-f0-9]{16}$';
  IF malformed_tenant_schemas IS NOT NULL THEN
    RAISE EXCEPTION 'Malformed tenant schema name(s): %', malformed_tenant_schemas;
  END IF;

  IF to_regclass('admin.tenant_schemas') IS NULL THEN
    RAISE EXCEPTION 'Required tenant schema registry admin.tenant_schemas is missing';
  END IF;
  IF to_regclass('auth.tenants') IS NULL THEN
    RAISE EXCEPTION 'Required tenant owner registry auth.tenants is missing';
  END IF;

  SELECT string_agg(
           format('%s->%s', ts."tenantId", ts."schemaName"),
           ', ' ORDER BY ts."tenantId"::text, ts."schemaName"
         )
    INTO tenant_registry_mapping_drift
    FROM admin.tenant_schemas ts
    LEFT JOIN auth.tenants tenant ON tenant.id = ts."tenantId"
   WHERE COALESCE(ts.status, 'active') <> 'deleted'
     AND (
       tenant.id IS NULL
       OR ts."schemaName" !~ '^tenant_[a-f0-9]{16}$'
       OR ts."schemaName" <>
          'tenant_' || left(replace(lower(ts."tenantId"::text), '-', ''), 16)
     );
  IF tenant_registry_mapping_drift IS NOT NULL THEN
    RAISE EXCEPTION
      'Tenant schema registry mapping disagrees with canonical tenant identity: %',
      tenant_registry_mapping_drift;
  END IF;

  SELECT string_agg(schema_name, ', ' ORDER BY schema_name)
    INTO tenant_registry_collisions
    FROM (
      SELECT ts."schemaName" AS schema_name
        FROM admin.tenant_schemas ts
       WHERE COALESCE(ts.status, 'active') <> 'deleted'
       GROUP BY ts."schemaName"
      HAVING count(DISTINCT ts."tenantId") > 1
    ) AS collisions;
  IF tenant_registry_collisions IS NOT NULL THEN
    RAISE EXCEPTION
      'Tenant schema registry has multiple owners for namespace(s): %',
      tenant_registry_collisions;
  END IF;

  WITH registered AS (
    SELECT DISTINCT ts."schemaName" AS schema_name
      FROM admin.tenant_schemas ts
      JOIN auth.tenants tenant ON tenant.id = ts."tenantId"
     WHERE COALESCE(ts.status, 'active') <> 'deleted'
  ),
  physical AS (
    SELECT nspname AS schema_name
      FROM pg_namespace
     WHERE nspname ~ '^tenant_[a-f0-9]{16}$'
  ),
  namespace_drift AS (
    SELECT 'missing:' || registered.schema_name AS detail
      FROM registered
     WHERE NOT EXISTS (
       SELECT 1 FROM physical WHERE physical.schema_name = registered.schema_name
     )
    UNION ALL
    SELECT 'untracked:' || physical.schema_name AS detail
      FROM physical
     WHERE NOT EXISTS (
       SELECT 1 FROM registered WHERE registered.schema_name = physical.schema_name
     )
  )
  SELECT string_agg(detail, ', ' ORDER BY detail)
    INTO tenant_registry_namespace_drift
    FROM namespace_drift;
  IF tenant_registry_namespace_drift IS NOT NULL THEN
    RAISE EXCEPTION
      'Tenant schema registry and physical namespace sets differ: %',
      tenant_registry_namespace_drift;
  END IF;

  FOR tenant_schema IN
    SELECT nspname
      FROM pg_namespace
     WHERE nspname ~ '^tenant_[a-f0-9]{16}$'
     ORDER BY nspname
  LOOP
    tenant_schema_names := tenant_schema_names || jsonb_build_array(tenant_schema);
  END LOOP;

  SELECT release_id, git_sha, expected_heads, tenant_fanout
    INTO release_row
    FROM platform.release_ledger
   WHERE status IN (
     'db_complete', 'apps_restarting', 'promoted', 'failed',
     'rollback_attempted', 'rollback_verified', 'rollback_failed', 'rolled_back'
   )
     AND expected_heads ? 'schemas'
   ORDER BY updated_at DESC, started_at DESC
   LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No DB-complete platform.release_ledger row carries migration heads';
  END IF;
  IF NOT (release_row.expected_heads ? 'tenants') THEN
    RAISE EXCEPTION
      'Release % omits the tenant migration head contract',
      release_row.release_id;
  END IF;

  FOR source_ordinal IN 1..array_length(source_schemas, 1) LOOP
    source_schema := source_schemas[source_ordinal];
    IF to_regclass(format('%I.migrations', source_schema)) IS NULL THEN
      RAISE EXCEPTION 'Source migration ledger %.migrations is missing', source_schema;
    END IF;

    EXECUTE format(
      'SELECT "timestamp"::text, name FROM %I.migrations ORDER BY "timestamp" DESC, id DESC LIMIT 1',
      source_schema
    ) INTO actual_timestamp, actual_name;
    IF actual_timestamp IS NULL OR actual_name IS NULL THEN
      RAISE EXCEPTION 'Source migration ledger %.migrations is empty', source_schema;
    END IF;

    expected_timestamp := release_row.expected_heads #>> ARRAY['schemas', source_schema, 'timestamp'];
    expected_name := release_row.expected_heads #>> ARRAY['schemas', source_schema, 'name'];
    IF expected_timestamp IS NULL OR expected_name IS NULL THEN
      RAISE EXCEPTION 'Release % declares no source migration head for %', release_row.release_id, source_schema;
    END IF;
    IF expected_timestamp <> actual_timestamp OR expected_name <> actual_name THEN
      RAISE EXCEPTION
        'Source migration head mismatch for %: expected=%@%, actual=%@%',
        source_schema, expected_name, expected_timestamp, actual_name, actual_timestamp;
    END IF;

    schema_heads := schema_heads || jsonb_build_array(
      jsonb_build_object(
        'schema', source_schema,
        'timestamp', actual_timestamp,
        'name', actual_name
      )
    );
  END LOOP;

  FOR tenant_schema IN
    SELECT nspname
      FROM pg_namespace
     WHERE nspname ~ '^tenant_[a-f0-9]{16}$'
     ORDER BY nspname
  LOOP
    FOR source_ordinal IN 1..array_length(tenant_aware_schemas, 1) LOOP
      source_schema := tenant_aware_schemas[source_ordinal];
      ledger_table := 'migrations_' || source_schema;
      IF to_regclass(format('%I.%I', tenant_schema, ledger_table)) IS NULL THEN
        RAISE EXCEPTION 'Tenant migration ledger %.% is missing', tenant_schema, ledger_table;
      END IF;

      EXECUTE format(
        'SELECT "timestamp"::text, name FROM %I.%I ORDER BY "timestamp" DESC, id DESC LIMIT 1',
        tenant_schema,
        ledger_table
      ) INTO actual_timestamp, actual_name;
      IF actual_timestamp IS NULL OR actual_name IS NULL THEN
        RAISE EXCEPTION 'Tenant migration ledger %.% is empty', tenant_schema, ledger_table;
      END IF;

      expected_timestamp := release_row.expected_heads #>> ARRAY[
        'tenants', tenant_schema, source_schema, 'timestamp'
      ];
      expected_name := release_row.expected_heads #>> ARRAY[
        'tenants', tenant_schema, source_schema, 'name'
      ];
      IF expected_timestamp IS NULL OR expected_name IS NULL THEN
        expected_timestamp := release_row.expected_heads #>> ARRAY[
          'schemas', source_schema, 'timestamp'
        ];
        expected_name := release_row.expected_heads #>> ARRAY[
          'schemas', source_schema, 'name'
        ];
      ELSIF release_row.tenant_fanout #> ARRAY[
        source_schema, 'tenants', tenant_schema
      ] IS NULL THEN
        RAISE EXCEPTION
          'Release % declares no fan-out evidence for tenant % source %',
          release_row.release_id, tenant_schema, source_schema;
      END IF;

      IF expected_timestamp IS NULL OR expected_name IS NULL THEN
        RAISE EXCEPTION
          'Release % declares no tenant or source migration head for tenant % source %',
          release_row.release_id, tenant_schema, source_schema;
      END IF;
      IF expected_timestamp <> actual_timestamp OR expected_name <> actual_name THEN
        RAISE EXCEPTION
          'Tenant migration head mismatch for % source %: expected=%@%, actual=%@%',
          tenant_schema, source_schema, expected_name, expected_timestamp, actual_name, actual_timestamp;
      END IF;

      tenant_heads := tenant_heads || jsonb_build_array(
        jsonb_build_object(
          'tenant_schema', tenant_schema,
          'source_schema', source_schema,
          'timestamp', actual_timestamp,
          'name', actual_name
        )
      );
    END LOOP;
  END LOOP;

  FOR sentinel IN
    SELECT * FROM (VALUES
        ${globalSentinelValues()}
    ) AS global_sentinels(ordinal, schema_name, table_name)
    ORDER BY ordinal
  LOOP
    IF to_regclass(format('%I.%I', sentinel.schema_name, sentinel.table_name)) IS NULL THEN
      RAISE EXCEPTION
        'Global sentinel relation %.% is missing', sentinel.schema_name, sentinel.table_name;
    END IF;
    EXECUTE format(
      'SELECT COUNT(*)::bigint, COALESCE(md5(string_agg(row_hash, '''' ORDER BY row_hash)), md5('''')) FROM (SELECT md5(to_jsonb(source_row)::text) AS row_hash FROM %I.%I AS source_row) AS hashed_rows',
      sentinel.schema_name,
      sentinel.table_name
    ) INTO sentinel_count, sentinel_checksum;
    sentinel_proofs := sentinel_proofs || jsonb_build_array(
      jsonb_build_object(
        'scope', 'global',
        'schema', sentinel.schema_name,
        'table', sentinel.table_name,
        'row_count', sentinel_count,
        'checksum', sentinel_checksum
      )
    );
  END LOOP;

  FOR tenant_schema IN
    SELECT nspname
      FROM pg_namespace
     WHERE nspname ~ '^tenant_[a-f0-9]{16}$'
     ORDER BY nspname
  LOOP
    FOR sentinel IN
      SELECT * FROM (VALUES
          ${tenantSentinelValues()}
      ) AS tenant_sentinels(ordinal, source_schema, table_name)
      ORDER BY ordinal
    LOOP
      IF to_regclass(format('%I.%I', tenant_schema, sentinel.table_name)) IS NULL THEN
        RAISE EXCEPTION
          'Tenant sentinel relation %.% is missing for source %',
          tenant_schema, sentinel.table_name, sentinel.source_schema;
      END IF;
      EXECUTE format(
        'SELECT COUNT(*)::bigint, COALESCE(md5(string_agg(row_hash, '''' ORDER BY row_hash)), md5('''')) FROM (SELECT md5(to_jsonb(source_row)::text) AS row_hash FROM %I.%I AS source_row) AS hashed_rows',
        tenant_schema,
        sentinel.table_name
      ) INTO sentinel_count, sentinel_checksum;
      sentinel_proofs := sentinel_proofs || jsonb_build_array(
        jsonb_build_object(
          'scope', 'tenant',
          'schema', tenant_schema,
          'table', sentinel.table_name,
          'row_count', sentinel_count,
          'checksum', sentinel_checksum
        )
      );
    END LOOP;
  END LOOP;

  verification_payload := jsonb_build_object(
    'contract_version', 1,
    'canonical_schemas', to_jsonb(canonical_schemas),
    'tenant_schemas', tenant_schema_names,
    'release', jsonb_build_object(
      'release_id', release_row.release_id,
      'git_sha', release_row.git_sha
    ),
    'migration_heads', jsonb_build_object(
      'schemas', schema_heads,
      'tenants', tenant_heads
    ),
    'sentinels', sentinel_proofs
  );
${finalStatement}
END`;
}

export function renderDatabaseVerificationSql(): string {
  const body = renderDatabaseVerificationBody(`  PERFORM set_config(
    'aqua.restore_verification_payload',
    verification_payload::text,
    true
  );`);

  return `-- GENERATED by tools/scripts/database/generate-database-verification-sql.ts
-- Source of truth: platform/libs/service-catalog/src/topology.ts
-- Regenerate: npx ts-node --project tools/gates/tsconfig.json tools/scripts/database/generate-database-verification-sql.ts generate
-- This collector must run inside a REPEATABLE READ, READ ONLY transaction.

SET LOCAL TIME ZONE 'UTC';
SET LOCAL DateStyle = 'ISO, YMD';
SET LOCAL extra_float_digits = 3;

DO $database_verification$
${body}
$database_verification$;

SELECT current_setting('aqua.restore_verification_payload', false);
`;
}

export function pitrSourceVerificationBaseRelations(): readonly string[] {
  const sourceMigrationRelations = migrationRunnerSchemas().map((schema) => `${schema}.migrations`);
  const globalSentinelRelations = GLOBAL_SENTINELS.map(
    (sentinel) => `${sentinel.schema}.${sentinel.table}`,
  );

  return [
    'admin.tenant_schemas',
    'auth.tenants',
    'platform.release_ledger',
    ...sourceMigrationRelations,
    ...globalSentinelRelations,
  ]
    .filter((relation, index, values) => values.indexOf(relation) === index)
    .sort();
}

export function pitrSourceVerificationTenantTables(): readonly string[] {
  return [
    ...tenantAwareSchemas().map((schema) => `migrations_${schema}`),
    ...TENANT_SENTINELS.map((sentinel) => sentinel.table),
  ].sort();
}

export function pitrSourceVerificationRootRelations(): readonly string[] {
  return ['admin.tenant_schemas', 'auth.tenants', 'platform.release_ledger'];
}

export function renderPitrSourceVerificationLocksSql(): string {
  const baseRelations = pitrSourceVerificationBaseRelations();
  const tenantTables = pitrSourceVerificationTenantTables();
  const rootRelations = pitrSourceVerificationRootRelations();
  const collectorBody = renderDatabaseVerificationBody(`  PERFORM pg_catalog.set_config(
    'aqua.pitr_source_verification_payload',
    verification_payload::text,
    true
  );`);

  if (baseRelations.length !== 19) {
    throw new Error(
      `Expected 19 source verification base relations, found ${baseRelations.length}`,
    );
  }
  if (tenantTables.length !== 14) {
    throw new Error(
      `Expected 14 source verification tables per tenant, found ${tenantTables.length}`,
    );
  }

  const relationSetDeclarations = `  base_relations constant text[] := ${textArray(baseRelations)};
  tenant_tables constant text[] := ${textArray(tenantTables)};
  relation_names text[] := base_relations;
  relation_name text;
  relation_oid oid;
  tenant_schema text;`;
  const relationSetBody = `  FOR tenant_schema IN
    SELECT nspname
      FROM pg_catalog.pg_namespace
     WHERE nspname ~ '^tenant_[a-f0-9]{16}$'
     ORDER BY nspname
  LOOP
    relation_names := relation_names || ARRAY(
      SELECT tenant_schema || '.' || tenant_table
        FROM unnest(tenant_tables) AS tenant_table
       ORDER BY tenant_table
    );
  END LOOP;

  SELECT array_agg(exact_relation ORDER BY exact_relation)
    INTO relation_names
    FROM (
      SELECT DISTINCT unnest(relation_names) AS exact_relation
    ) AS exact_relations;

  FOREACH relation_name IN ARRAY relation_names LOOP
    relation_oid := pg_catalog.to_regclass(relation_name);
    IF relation_oid IS NULL THEN
      RAISE EXCEPTION 'PITR source verification relation % is missing', relation_name;
    END IF;
    IF NOT EXISTS (
      SELECT 1
        FROM pg_catalog.pg_class
       WHERE oid = relation_oid
         AND relkind IN ('r', 'p')
    ) THEN
      RAISE EXCEPTION 'PITR source verification relation % is not a table', relation_name;
    END IF;
  END LOOP;`;

  return `-- GENERATED by tools/scripts/database/generate-database-verification-sql.ts
-- Source of truth: platform topology plus GLOBAL_SENTINELS/TENANT_SENTINELS above.
-- The protected caller keeps one READ COMMITTED, READ ONLY transaction open
-- through the separately committed AFTER WAL marker. This file installs no
-- persistent database object and therefore has no deployment bootstrap edge.

SET LOCAL TIME ZONE 'UTC';
SET LOCAL DateStyle = 'ISO, YMD';
SET LOCAL extra_float_digits = 3;
SET LOCAL search_path = pg_catalog, platform;
SET LOCAL row_security = off;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';
SET LOCAL idle_in_transaction_session_timeout = '30s';

DO $pitr_source_lock$
DECLARE
${relationSetDeclarations}
  lock_sql text;
  computed_lock_set_sha256 text;
BEGIN
  IF current_setting('transaction_read_only') <> 'on'
     OR current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'PITR source verification requires READ COMMITTED, READ ONLY';
  END IF;
  IF (SELECT setting::integer FROM pg_catalog.pg_settings WHERE name = 'lock_timeout') <> 5000
     OR (SELECT setting::integer FROM pg_catalog.pg_settings WHERE name = 'statement_timeout') <> 120000
     OR (SELECT setting::integer FROM pg_catalog.pg_settings WHERE name = 'idle_in_transaction_session_timeout') <> 30000 THEN
    RAISE EXCEPTION 'PITR source verification timeout envelope is not canonical';
  END IF;
  IF current_user <> session_user OR NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_roles
     WHERE rolname = session_user
       AND rolsuper
  ) THEN
    RAISE EXCEPTION 'PITR source verification requires the existing source superuser session';
  END IF;

  LOCK TABLE ${rootRelations.join(', ')} IN SHARE MODE;
${relationSetBody}

  SELECT 'LOCK TABLE ' || string_agg(
           format('%I.%I', split_part(exact_relation, '.', 1), split_part(exact_relation, '.', 2)),
           ', ' ORDER BY exact_relation
         ) || ' IN SHARE MODE'
    INTO lock_sql
    FROM unnest(relation_names) AS exact_relation;
  EXECUTE lock_sql;

  FOREACH relation_name IN ARRAY relation_names LOOP
    relation_oid := pg_catalog.to_regclass(relation_name);
    IF NOT EXISTS (
      SELECT 1
        FROM pg_catalog.pg_locks
       WHERE pid = pg_catalog.pg_backend_pid()
         AND locktype = 'relation'
         AND relation = relation_oid
         AND mode = 'ShareLock'
         AND granted
    ) THEN
      RAISE EXCEPTION 'PITR source verification relation % lacks its SHARE lock', relation_name;
    END IF;
  END LOOP;

  computed_lock_set_sha256 := encode(
    public.digest(array_to_string(relation_names, E'\\n'), 'sha256'),
    'hex'
  );
  PERFORM pg_catalog.set_config('aqua.pitr_source_roots_locked', 'on', true);
  PERFORM pg_catalog.set_config(
    'aqua.pitr_source_lock_set_sha256',
    computed_lock_set_sha256,
    true
  );
  PERFORM pg_catalog.set_config(
    'aqua.pitr_source_lock_count',
    cardinality(relation_names)::text,
    true
  );
  PERFORM pg_catalog.set_config(
    'aqua.pitr_source_lock_relations',
    to_jsonb(relation_names)::text,
    true
  );
END
$pitr_source_lock$;

DO $pitr_source_database_verification$
${collectorBody}
$pitr_source_database_verification$;

DO $pitr_source_capture$
DECLARE
${relationSetDeclarations}
  computed_lock_set_sha256 text;
  expected_lock_set_sha256 text;
  expected_lock_count integer;
  captured_snapshot_id text;
  completed_clock timestamptz;
BEGIN
  IF current_setting('transaction_read_only') <> 'on'
     OR current_setting('transaction_isolation') <> 'read committed'
     OR current_setting('aqua.pitr_source_roots_locked', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'PITR source capture requires the locked READ COMMITTED, READ ONLY transaction';
  END IF;
${relationSetBody}

  FOREACH relation_name IN ARRAY relation_names LOOP
    relation_oid := pg_catalog.to_regclass(relation_name);
    IF NOT EXISTS (
      SELECT 1
        FROM pg_catalog.pg_locks
       WHERE pid = pg_catalog.pg_backend_pid()
         AND locktype = 'relation'
         AND relation = relation_oid
         AND mode = 'ShareLock'
         AND granted
    ) THEN
      RAISE EXCEPTION 'PITR source capture relation % lacks its SHARE lock', relation_name;
    END IF;
  END LOOP;

  computed_lock_set_sha256 := encode(
    public.digest(array_to_string(relation_names, E'\\n'), 'sha256'),
    'hex'
  );
  expected_lock_set_sha256 := current_setting('aqua.pitr_source_lock_set_sha256', true);
  expected_lock_count := NULLIF(current_setting('aqua.pitr_source_lock_count', true), '')::integer;
  IF expected_lock_set_sha256 IS DISTINCT FROM computed_lock_set_sha256
     OR expected_lock_count IS DISTINCT FROM cardinality(relation_names) THEN
    RAISE EXCEPTION 'PITR source capture lock-set attestation does not match held locks';
  END IF;
  IF current_setting('aqua.pitr_source_lock_relations', true)::jsonb
     IS DISTINCT FROM to_jsonb(relation_names) THEN
    RAISE EXCEPTION 'PITR source capture relation preimage changed after lock acquisition';
  END IF;
  IF current_setting('aqua.pitr_source_verification_payload', true) IS NULL THEN
    RAISE EXCEPTION 'PITR source capture has no canonical verification payload';
  END IF;

  captured_snapshot_id := pg_catalog.pg_export_snapshot();
  completed_clock := pg_catalog.clock_timestamp();
  PERFORM pg_catalog.set_config('aqua.pitr_source_snapshot_id', captured_snapshot_id, true);
  PERFORM pg_catalog.set_config(
    'aqua.pitr_source_snapshot_sha256',
    encode(public.digest(captured_snapshot_id, 'sha256'), 'hex'),
    true
  );
  PERFORM pg_catalog.set_config(
    'aqua.pitr_source_completed_at',
    to_char(completed_clock AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    true
  );
  PERFORM pg_catalog.set_config(
    'aqua.pitr_source_floor_lsn',
    pg_catalog.pg_current_wal_lsn()::text,
    true
  );
  PERFORM pg_catalog.set_config(
    'aqua.pitr_recovery_target_time',
    to_char(
      (completed_clock + interval '2 seconds') AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    ),
    true
  );
END
$pitr_source_capture$;

SELECT 'ROOTS_LOCKED';

SELECT concat_ws(
  '|',
  current_setting('aqua.pitr_source_lock_set_sha256'),
  current_setting('aqua.pitr_source_lock_count'),
  (SELECT setting FROM pg_catalog.pg_settings WHERE name = 'lock_timeout'),
  (SELECT setting FROM pg_catalog.pg_settings WHERE name = 'statement_timeout'),
  (SELECT setting FROM pg_catalog.pg_settings WHERE name = 'idle_in_transaction_session_timeout')
);

SELECT concat_ws(
  '|',
  current_setting('aqua.pitr_source_snapshot_id'),
  current_setting('aqua.pitr_source_snapshot_sha256'),
  current_setting('aqua.pitr_source_lock_set_sha256'),
  current_setting('aqua.pitr_source_lock_count'),
  replace(replace(
    encode(
      convert_to(current_setting('aqua.pitr_source_lock_relations'), 'UTF8'),
      'base64'
    ),
    E'\\n',
    ''
  ), E'\\r', ''),
  current_setting('aqua.pitr_source_completed_at'),
  current_setting('aqua.pitr_source_floor_lsn'),
  current_setting('aqua.pitr_recovery_target_time'),
  replace(replace(
    encode(
      convert_to(current_setting('aqua.pitr_source_verification_payload'), 'UTF8'),
      'base64'
    ),
    E'\\n',
    ''
  ), E'\\r', '')
);

SELECT 'SOURCE_VERIFICATION_CAPTURED';
`;
}

function main(): void {
  const mode = process.argv[2];
  const rendered = renderDatabaseVerificationSql();
  const renderedPitrLocks = renderPitrSourceVerificationLocksSql();
  if (mode === 'generate') {
    writeFileSync(OUTPUT_PATH, rendered, 'utf8');
    writeFileSync(PITR_LOCK_OUTPUT_PATH, renderedPitrLocks, 'utf8');
    process.stdout.write(`${OUTPUT_PATH}: generated\n`);
    process.stdout.write(`${PITR_LOCK_OUTPUT_PATH}: generated\n`);
    return;
  }
  if (mode === 'check') {
    const current = readFileSync(OUTPUT_PATH, 'utf8');
    const currentPitrLocks = readFileSync(PITR_LOCK_OUTPUT_PATH, 'utf8');
    let stale = false;
    if (current !== rendered) {
      process.stderr.write(
        `${OUTPUT_PATH}: stale; run generate-database-verification-sql.ts generate\n`,
      );
      stale = true;
    }
    if (currentPitrLocks !== renderedPitrLocks) {
      process.stderr.write(
        `${PITR_LOCK_OUTPUT_PATH}: stale; run generate-database-verification-sql.ts generate\n`,
      );
      stale = true;
    }
    if (stale) {
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`${OUTPUT_PATH}: ok\n${PITR_LOCK_OUTPUT_PATH}: ok\n`);
    return;
  }
  process.stderr.write('Usage: generate-database-verification-sql.ts <generate|check>\n');
  process.exitCode = 2;
}

if (require.main === module) {
  main();
}
