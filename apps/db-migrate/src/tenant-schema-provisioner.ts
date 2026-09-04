import { resolve } from 'node:path';

import {
  applyTenantRlsToSchema,
  assertTenantSchemaPrivileges,
  convertAuditColumnsToTimestamptz,
  getTenantSchemaName,
  grantTenantMessagingPartitionAuthority,
  grantTenantMigrationLedgerReadAccess,
  MIGRATION_LEDGER_TABLE,
  tenantMigrationLedgerTable,
  TENANT_AWARE_SCHEMAS,
  TENANT_SCHEMA_NAME_RE,
  queryRowsNormalized,
  queryRowCountNormalized,
  verifySourceSchemaWriteGuards,
  verifyTenantSchemaPrivileges,
} from '@aquaculture/backend-common/database';
import { DataSource, QueryRunner } from 'typeorm';

import {
  readLedgerHead,
  runSchemaMigrations,
  type MigrationLedgerHead,
  type RunSchemaOptions,
} from './migration-orchestrator';
import { SCHEMA_REGISTRY, type SchemaPostMigrationHardening } from './schema-registry';
import { ensureTenantSensorContinuousAggregateAuthority } from './tenant-sensor-continuous-aggregate-authority';

type TenantSchemaJobStatus =
  | 'REQUESTED'
  | 'CLAIMED'
  | 'CREATING_SCHEMA'
  | 'COPYING_TABLES'
  | 'APPLYING_GRANTS'
  | 'HARDENING_RLS'
  | 'SEEDING_LEDGER'
  | 'RECONCILING_SCHEMA'
  | 'DELETING_SCHEMA'
  | 'COMMITTED'
  | 'FAILED'
  | 'ABORTED'
  | 'DELETED';

interface TenantSchemaJob {
  id: string;
  operationId: string;
  tenantId: string;
  schemaName: string;
  jobType: 'PROVISION' | 'DELETE' | 'RECONCILE_EXISTING_SCHEMA';
  status: TenantSchemaJobStatus;
  attempts: number;
  leaseToken: string;
  requestPayload: Record<string, unknown>;
}

interface TenantSchemaLease {
  readonly leaseSeconds: number;
}

export interface TenantSchemaProvisionerOptions {
  database: RunSchemaOptions['database'];
  root: string;
  once: boolean;
  pollIntervalMs?: number;
  leaseSeconds?: number;
  provisionerId?: string;
  log: (record: Record<string, unknown>) => void;
}

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_LEASE_SECONDS = 900;

function createControlDataSource(database: RunSchemaOptions['database'], max = 2): DataSource {
  return new DataSource({
    type: 'postgres',
    host: database.host,
    port: database.port,
    username: database.username,
    password: database.password,
    database: database.database,
    migrationsRun: false,
    synchronize: false,
    logging: false,
    ssl: database.ssl,
    extra: { max },
  });
}

function quoteIdent(identifier: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(identifier)) {
    throw new Error(`[tenant-schema-provisioner] Unsafe SQL identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}

function headToJson(head: MigrationLedgerHead | null): Record<string, string> | null {
  if (!head) return null;
  return {
    timestamp: head.timestamp,
    name: head.name,
  };
}

async function queryRows<T extends Record<string, unknown>>(
  queryRunner: QueryRunner,
  sql: string,
  params?: unknown[],
): Promise<T[]> {
  const result: unknown = await queryRunner.query(sql, params);
  return queryRowsNormalized<T>(result);
}

async function executeLeaseBoundUpdate(
  queryRunner: QueryRunner,
  job: TenantSchemaJob,
  sql: string,
  params: unknown[],
  action: string,
): Promise<void> {
  const result: unknown = await queryRunner.query(sql, params);
  const rowCount = queryRowCountNormalized(result);
  if (rowCount !== 1) {
    throw new Error(`[tenant-schema-provisioner] Lease lost while ${action} for job ${job.id}`);
  }
}

async function renewJobLease(
  queryRunner: QueryRunner,
  job: TenantSchemaJob,
  lease: TenantSchemaLease,
): Promise<void> {
  await executeLeaseBoundUpdate(
    queryRunner,
    job,
    `UPDATE platform.tenant_schema_jobs
        SET heartbeat_at = NOW(),
            lease_expires_at = NOW() + ($2 || ' seconds')::interval,
            updated_at = NOW()
      WHERE id = $1
        AND lease_token = $3`,
    [job.id, lease.leaseSeconds, job.leaseToken],
    'renewing lease',
  );
}

async function setJobStatus(
  queryRunner: QueryRunner,
  job: TenantSchemaJob,
  status: TenantSchemaJobStatus,
  lease: TenantSchemaLease,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await executeLeaseBoundUpdate(
    queryRunner,
    job,
    `UPDATE platform.tenant_schema_jobs
        SET status = $2,
            heartbeat_at = NOW(),
            lease_expires_at = CASE
              WHEN $6::boolean THEN lease_expires_at
              ELSE NOW() + ($7 || ' seconds')::interval
            END,
            updated_at = NOW(),
            ${
              status === 'COMMITTED' ||
              status === 'FAILED' ||
              status === 'ABORTED' ||
              status === 'DELETED'
                ? 'completed_at = NOW(),'
                : ''
            }
            failure_residue = COALESCE($3::jsonb, failure_residue),
            error_message = COALESCE($4, error_message)
      WHERE id = $1
        AND lease_token = $5`,
    [
      job.id,
      status,
      extra['failureResidue'] === undefined ? null : JSON.stringify(extra['failureResidue']),
      typeof extra['errorMessage'] === 'string' ? extra['errorMessage'] : null,
      job.leaseToken,
      status === 'COMMITTED' || status === 'FAILED' || status === 'ABORTED' || status === 'DELETED',
      lease.leaseSeconds,
    ],
    `setting status ${status}`,
  );
  job.status = status;
}

async function claimNextJob(
  queryRunner: QueryRunner,
  provisionerId: string,
  leaseSeconds: number,
): Promise<TenantSchemaJob | null> {
  const leaseRows = await queryRows<{
    id: string;
    operation_id: string;
    tenant_id: string;
    schema_name: string;
    job_type: 'PROVISION' | 'DELETE' | 'RECONCILE_EXISTING_SCHEMA';
    status: TenantSchemaJobStatus;
    attempts: number;
    lease_token: string;
    request_payload: Record<string, unknown> | null;
  }>(
    queryRunner,
    `UPDATE platform.tenant_schema_jobs
        SET status = 'CLAIMED',
            attempts = attempts + 1,
            lease_token = gen_random_uuid(),
            leased_by = $1,
            heartbeat_at = NOW(),
            lease_expires_at = NOW() + ($2 || ' seconds')::interval,
            started_at = COALESCE(started_at, NOW()),
            updated_at = NOW()
      WHERE id = (
        SELECT id
          FROM platform.tenant_schema_jobs
         WHERE job_type IN ('PROVISION', 'DELETE', 'RECONCILE_EXISTING_SCHEMA')
           AND (
             status = 'REQUESTED'
             OR (
               status IN ('CLAIMED', 'CREATING_SCHEMA', 'COPYING_TABLES', 'APPLYING_GRANTS', 'HARDENING_RLS', 'SEEDING_LEDGER', 'RECONCILING_SCHEMA', 'DELETING_SCHEMA')
               AND lease_expires_at < NOW()
             )
           )
         ORDER BY created_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 1
      )
      RETURNING id, operation_id, tenant_id, schema_name, job_type, status, attempts, lease_token, request_payload`,
    [provisionerId, leaseSeconds],
  );

  const row = leaseRows[0];
  if (!row) return null;
  return {
    id: row.id,
    operationId: row.operation_id,
    tenantId: row.tenant_id,
    schemaName: row.schema_name,
    jobType: row.job_type,
    status: row.status,
    attempts: row.attempts,
    leaseToken: row.lease_token,
    requestPayload: row.request_payload ?? {},
  };
}

async function countTenantTables(queryRunner: QueryRunner, schemaName: string): Promise<number> {
  const rows = await queryRows<{ count: string }>(
    queryRunner,
    `SELECT COUNT(*)::text AS count
       FROM information_schema.tables
      WHERE table_schema = $1
        AND table_type = 'BASE TABLE'`,
    [schemaName],
  );
  return Number.parseInt(rows[0]?.count ?? '0', 10);
}

async function assertTenantSchemaIdentityAvailable(
  queryRunner: QueryRunner,
  job: TenantSchemaJob,
): Promise<void> {
  const collision = await queryRows<{ tenant_id: string }>(
    queryRunner,
    `SELECT "tenantId"::text AS tenant_id
       FROM admin.tenant_schemas
      WHERE "schemaName" = $1
        AND "tenantId" <> $2::uuid
      LIMIT 1`,
    [job.schemaName, job.tenantId],
  );
  if (collision.length > 0) {
    throw new Error(
      `[tenant-schema-provisioner] Tenant schema identity collision for ${job.schemaName}`,
    );
  }
}

async function readTenantHead(
  queryRunner: QueryRunner,
  schemaName: string,
  sourceSchema: string,
): Promise<MigrationLedgerHead | null> {
  return readLedgerHead(queryRunner, schemaName, tenantMigrationLedgerTable(sourceSchema));
}

async function applyProvisionerHardening(
  queryRunner: QueryRunner,
  schemaName: string,
  hardening: SchemaPostMigrationHardening,
  log: TenantSchemaProvisionerOptions['log'],
): Promise<void> {
  const helperLogger = {
    log: (message: string): void =>
      log({ level: 'info', message, context: 'TenantSchemaProvisionerHardening', schemaName }),
    warn: (message: string): void =>
      log({ level: 'warn', message, context: 'TenantSchemaProvisionerHardening', schemaName }),
  };

  if (hardening.tenantRls !== undefined) {
    const rlsOptions = hardening.tenantRls === true ? {} : hardening.tenantRls;
    await applyTenantRlsToSchema(queryRunner, {
      schemaOverride: schemaName,
      logger: helperLogger,
      ...(rlsOptions.excludeTables !== undefined
        ? { excludeTables: rlsOptions.excludeTables }
        : {}),
      ...(rlsOptions.tenantIdColumns !== undefined
        ? { tenantIdColumns: rlsOptions.tenantIdColumns }
        : {}),
    });
  }

  if (hardening.auditColumns !== undefined) {
    const auditOptions = hardening.auditColumns === true ? {} : hardening.auditColumns;
    await convertAuditColumnsToTimestamptz(queryRunner, {
      schemaOverride: schemaName,
      logger: helperLogger,
      ...(auditOptions.excludeTables !== undefined
        ? { excludeTables: auditOptions.excludeTables }
        : {}),
      ...(auditOptions.auditColumns !== undefined
        ? { auditColumns: auditOptions.auditColumns }
        : {}),
    });
  }
}

/**
 * Job-blocking privilege gate (2026-07-06 grant incident): before a PROVISION
 * or RECONCILE job may COMMIT, every registered-and-present per-tenant table
 * must carry its <source>_schema_owner ownership + <source>_service DML.
 * Unknown (unregistered) tenant tables are logged loudly — they carry no
 * managed grants and their owning service WILL fail at runtime.
 */
async function assertTenantPrivilegesVerified(
  queryRunner: QueryRunner,
  tenantSchema: string,
  log: (record: Record<string, unknown>) => void,
): Promise<void> {
  const verification = await verifyTenantSchemaPrivileges(queryRunner, tenantSchema, [
    ...TENANT_AWARE_SCHEMAS,
  ]);
  if (verification.unknownTables.length > 0) {
    log({
      level: 'warn',
      message:
        'Tenant schema contains tables registered by NO module — register them in ' +
        'MODULE_SCHEMAS or drop them; they carry no managed grants.',
      context: 'TenantSchemaProvisioner',
      tenantSchema,
      unknownTables: verification.unknownTables,
    });
  }
  if (verification.violations.length > 0) {
    throw new Error(
      `[tenant-schema-provisioner] Tenant-schema privilege drift in ${tenantSchema}: ` +
        verification.violations
          .map((v) => `${v.sourceSchema}.${v.table} (${v.kind}: ${v.detail})`)
          .join('; '),
    );
  }
}

/**
 * Job-blocking source-schema write-guard gate (ORPHAN-HIGH-087 /
 * FARM-CRITICAL-061): refuse to provision from a source whose guards have
 * drifted — a guard missing from a per-tenant data table, or MISplaced on a
 * reference/infrastructure table. Read-only: the provisioner never installs
 * source DDL (deploy owns that under the release lock), it only verifies.
 */
async function assertSourceSchemaWriteGuardsVerified(
  queryRunner: QueryRunner,
  log: (record: Record<string, unknown>) => void,
): Promise<void> {
  const drift: string[] = [];
  for (const sourceSchema of TENANT_AWARE_SCHEMAS) {
    const verification = await verifySourceSchemaWriteGuards(queryRunner, sourceSchema);
    if (verification.missing.length > 0 || verification.misplaced.length > 0) {
      drift.push(
        `${sourceSchema} (missing: [${verification.missing.join(', ')}]; ` +
          `misplaced: [${verification.misplaced.join(', ')}])`,
      );
    }
  }
  if (drift.length > 0) {
    log({
      level: 'error',
      message:
        'Source-schema write-guard drift detected — refusing to provision from a drifted source',
      context: 'TenantSchemaProvisioner',
      drift,
    });
    throw new Error(
      `[tenant-schema-provisioner] Source-schema write-guard drift: ${drift.join('; ')}`,
    );
  }
}

async function commitTenantSchemaRecord(
  queryRunner: QueryRunner,
  job: TenantSchemaJob,
  tableCount: number,
  sourceHeads: Record<string, unknown>,
  tenantHeads: Record<string, unknown>,
): Promise<void> {
  await queryRunner.query(
    `INSERT INTO admin.tenant_schemas (
       "tenantId",
       "schemaName",
       status,
       "currentVersion",
       "tableCount",
       metadata,
       "lastMigrationAt",
       "createdAt",
       "updatedAt"
     ) VALUES (
       $1,
       $2,
       'active',
       '1.0.0',
       $3,
       $4::jsonb,
       NOW(),
       NOW(),
       NOW()
     )
     ON CONFLICT ("tenantId") DO UPDATE SET
       "schemaName" = EXCLUDED."schemaName",
       status = 'active',
       "tableCount" = EXCLUDED."tableCount",
       metadata = EXCLUDED.metadata,
       "lastMigrationAt" = NOW(),
       "updatedAt" = NOW()`,
    [
      job.tenantId,
      job.schemaName,
      tableCount,
      JSON.stringify({
        provisioner: 'aqua-db-migrate',
        jobType: job.jobType,
        operationId: job.operationId,
        sourceHeads,
        tenantHeads,
      }),
    ],
  );
}

async function writeJobEvidence(
  queryRunner: QueryRunner,
  job: TenantSchemaJob,
  lease: TenantSchemaLease,
  args: {
    status: TenantSchemaJobStatus;
    sourceHeads: Record<string, unknown>;
    tenantHeads: Record<string, unknown>;
    tableCount: number;
    failureResidue?: Record<string, unknown>;
    errorMessage?: string;
  },
): Promise<void> {
  await executeLeaseBoundUpdate(
    queryRunner,
    job,
    `UPDATE platform.tenant_schema_jobs
        SET status = $2,
            source_heads = $3::jsonb,
            tenant_heads = $4::jsonb,
            table_count = $5,
            failure_residue = COALESCE($6::jsonb, failure_residue),
            error_message = $7,
            heartbeat_at = NOW(),
            lease_expires_at = CASE
              WHEN $9::boolean THEN lease_expires_at
              ELSE NOW() + ($10 || ' seconds')::interval
            END,
            completed_at = CASE WHEN $9::boolean THEN NOW() ELSE completed_at END,
            updated_at = NOW()
      WHERE id = $1
        AND lease_token = $8`,
    [
      job.id,
      args.status,
      JSON.stringify(args.sourceHeads),
      JSON.stringify(args.tenantHeads),
      args.tableCount,
      args.failureResidue === undefined ? null : JSON.stringify(args.failureResidue),
      args.errorMessage ?? null,
      job.leaseToken,
      args.status === 'COMMITTED' ||
        args.status === 'FAILED' ||
        args.status === 'ABORTED' ||
        args.status === 'DELETED',
      lease.leaseSeconds,
    ],
    `writing ${args.status} evidence`,
  );
}

/**
 * Publish the admin schema record and the lease-fenced COMMITTED job evidence
 * as one database fact. The active mapping is consumed by FORCE-RLS background
 * workers, so an active admin row without its matching committed operation
 * must never become visible.
 */
async function commitTenantSchemaEvidence(
  queryRunner: QueryRunner,
  job: TenantSchemaJob,
  lease: TenantSchemaLease,
  args: {
    tableCount: number;
    sourceHeads: Record<string, unknown>;
    tenantHeads: Record<string, unknown>;
    failureResidue?: Record<string, unknown>;
  },
): Promise<void> {
  await queryRunner.startTransaction();
  try {
    await commitTenantSchemaRecord(
      queryRunner,
      job,
      args.tableCount,
      args.sourceHeads,
      args.tenantHeads,
    );
    await writeJobEvidence(queryRunner, job, lease, {
      status: 'COMMITTED',
      sourceHeads: args.sourceHeads,
      tenantHeads: args.tenantHeads,
      tableCount: args.tableCount,
      ...(args.failureResidue !== undefined ? { failureResidue: args.failureResidue } : {}),
    });
    await queryRunner.commitTransaction();
  } catch (error) {
    if (queryRunner.isTransactionActive) {
      await queryRunner.rollbackTransaction();
    }
    throw error;
  }
}

async function collectFailureResidue(
  queryRunner: QueryRunner,
  job: TenantSchemaJob,
): Promise<Record<string, unknown>> {
  const schemaExists = await queryRows<{ exists: boolean }>(
    queryRunner,
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.schemata WHERE schema_name = $1
     ) AS exists`,
    [job.schemaName],
  );
  const tableCount = schemaExists[0]?.exists
    ? await countTenantTables(queryRunner, job.schemaName)
    : 0;
  return {
    schemaName: job.schemaName,
    schemaExists: schemaExists[0]?.exists ?? false,
    tableCount,
    capturedAt: new Date().toISOString(),
  };
}

async function deleteFarmSourceProvenanceForTenant(
  queryRunner: QueryRunner,
  job: TenantSchemaJob,
): Promise<number> {
  const tableRows = await queryRows<{ exists: boolean }>(
    queryRunner,
    `SELECT to_regclass('farm.feeding_record_provenance') IS NOT NULL AS exists`,
  );
  if (tableRows[0]?.exists !== true) {
    return 0;
  }

  await queryRunner.query(
    `SELECT pg_catalog.set_config('aqua.tenant_schema_delete_operation', $1, true),
            pg_catalog.set_config('aqua.tenant_schema_delete_tenant', $2, true)`,
    [job.operationId, job.tenantId],
  );
  const rows = await queryRows<{ deletedCount: string }>(
    queryRunner,
    `WITH deleted AS (
       DELETE FROM farm.feeding_record_provenance
        WHERE tenant_id = $1
        RETURNING 1
     )
     SELECT COUNT(*)::text AS "deletedCount" FROM deleted`,
    [job.tenantId],
  );
  return Number.parseInt(rows[0]?.deletedCount ?? '0', 10);
}

async function processDeleteJob(
  job: TenantSchemaJob,
  options: TenantSchemaProvisionerOptions,
): Promise<void> {
  const control = createControlDataSource(options.database);
  await control.initialize();
  const queryRunner = control.createQueryRunner();
  const lease = { leaseSeconds: options.leaseSeconds ?? DEFAULT_LEASE_SECONDS };
  let beforeTableCount = 0;
  let sourceProvenanceRowsDeleted = 0;

  try {
    await queryRunner.connect();
    await assertTenantSchemaIdentityAvailable(queryRunner, job);
    assertDeleteProof(job);
    await setJobStatus(queryRunner, job, 'DELETING_SCHEMA', lease);
    await queryRunner.startTransaction();
    beforeTableCount = await countTenantTables(queryRunner, job.schemaName);
    sourceProvenanceRowsDeleted = await deleteFarmSourceProvenanceForTenant(queryRunner, job);
    await renewJobLease(queryRunner, job, lease);
    await queryRunner.query(`DROP SCHEMA IF EXISTS ${quoteIdent(job.schemaName)} CASCADE`);
    await renewJobLease(queryRunner, job, lease);
    await executeLeaseBoundUpdate(
      queryRunner,
      job,
      `UPDATE admin.tenant_schemas
          SET status = 'deleted',
              metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb,
              "tableCount" = 0,
              "updatedAt" = NOW()
        WHERE "tenantId" = $1
          AND "schemaName" = $3`,
      [
        job.tenantId,
        JSON.stringify({
          deletedBy: 'aqua-db-migrate',
          operationId: job.operationId,
          schemaName: job.schemaName,
          beforeTableCount,
          sourceProvenanceRowsDeleted,
          deletedAt: new Date().toISOString(),
        }),
        job.schemaName,
      ],
      'writing admin.tenant_schemas delete evidence',
    );
    await writeJobEvidence(queryRunner, job, lease, {
      status: 'DELETED',
      sourceHeads: {},
      tenantHeads: {},
      tableCount: 0,
      failureResidue: {
        schemaName: job.schemaName,
        dropped: true,
        beforeTableCount,
        sourceProvenanceRowsDeleted,
        capturedAt: new Date().toISOString(),
      },
    });
    await queryRunner.commitTransaction();
    options.log({
      level: 'info',
      message: 'Tenant schema provisioner deleted tenant schema',
      context: 'TenantSchemaProvisioner',
      jobId: job.id,
      operationId: job.operationId,
      tenantId: job.tenantId,
      schemaName: job.schemaName,
      beforeTableCount,
      sourceProvenanceRowsDeleted,
    });
  } catch (error: unknown) {
    if (queryRunner.isTransactionActive) {
      await queryRunner.rollbackTransaction();
    }
    const failureResidue = await collectFailureResidue(queryRunner, job).catch(
      (residueError: unknown) => ({
        residueCaptureFailed:
          residueError instanceof Error ? residueError.message : String(residueError),
      }),
    );
    await writeJobEvidence(queryRunner, job, lease, {
      status: 'FAILED',
      sourceHeads: {},
      tenantHeads: {},
      tableCount: beforeTableCount,
      failureResidue,
      errorMessage: error instanceof Error ? error.message : String(error),
    }).catch((writeError: unknown) => {
      options.log({
        level: 'error',
        message: 'Tenant schema provisioner failed to write delete failure evidence',
        context: 'TenantSchemaProvisioner',
        jobId: job.id,
        error: writeError instanceof Error ? writeError.message : String(writeError),
      });
    });
    throw error;
  } finally {
    await queryRunner.release();
    await control.destroy();
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function assertDeleteProof(job: TenantSchemaJob): void {
  const payload = asRecord(job.requestPayload);
  const proof = asRecord(payload?.['cleanupProof']);
  const backup = asRecord(proof?.['backup']);
  const tombstone = asRecord(payload?.['tombstone']);
  const preCounts = asRecord(proof?.['preCounts']);
  const existingSchemas = preCounts?.['existingSchemas'];

  if (!proof) {
    throw new Error(`[tenant-schema-provisioner] DELETE job ${job.id} is missing cleanupProof`);
  }
  if (proof['operationId'] !== job.operationId || proof['tenantId'] !== job.tenantId) {
    throw new Error(
      `[tenant-schema-provisioner] DELETE job ${job.id} cleanupProof does not match job`,
    );
  }
  if (proof['purpose'] !== 'tenant_deprovision' && proof['purpose'] !== 'tenant_erasure') {
    throw new Error(
      `[tenant-schema-provisioner] DELETE job ${job.id} requires tenant_deprovision or tenant_erasure proof`,
    );
  }
  if (typeof proof['legalHoldCheckedAt'] !== 'string' || proof['legalHoldCheckedAt'].length === 0) {
    throw new Error(
      `[tenant-schema-provisioner] DELETE job ${job.id} requires legal-hold evidence`,
    );
  }
  if (
    proof['purpose'] === 'tenant_deprovision' &&
    (!backup ||
      backup['isEncrypted'] !== true ||
      typeof backup['checksum'] !== 'string' ||
      backup['checksum'].length === 0 ||
      Number(backup['sizeBytes']) <= 0)
  ) {
    throw new Error(
      `[tenant-schema-provisioner] DELETE job ${job.id} requires encrypted backup evidence`,
    );
  }
  if (!preCounts || !Array.isArray(existingSchemas)) {
    throw new Error(
      `[tenant-schema-provisioner] DELETE job ${job.id} requires pre-delete count evidence`,
    );
  }
  if (!existingSchemas.includes(job.schemaName)) {
    throw new Error(
      `[tenant-schema-provisioner] DELETE job ${job.id} pre-delete evidence must include target schema ${job.schemaName}`,
    );
  }
  if (!tombstone || tombstone['cleanupRunId'] !== proof['operationId']) {
    throw new Error(
      `[tenant-schema-provisioner] DELETE job ${job.id} requires matching tombstone evidence`,
    );
  }
}

async function processReconcileJob(
  job: TenantSchemaJob,
  options: TenantSchemaProvisionerOptions,
): Promise<void> {
  const control = createControlDataSource(options.database);
  await control.initialize();
  const queryRunner = control.createQueryRunner();
  const lease = { leaseSeconds: options.leaseSeconds ?? DEFAULT_LEASE_SECONDS };
  const sourceHeads: Record<string, unknown> = {};
  const tenantHeads: Record<string, unknown> = {};
  let tableCount = 0;

  try {
    await queryRunner.connect();
    await assertTenantSchemaIdentityAvailable(queryRunner, job);
    await setJobStatus(queryRunner, job, 'RECONCILING_SCHEMA', lease);

    const schemaExistsRows = await queryRows<{ exists: boolean }>(
      queryRunner,
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.schemata WHERE schema_name = $1
       ) AS exists`,
      [job.schemaName],
    );
    if (schemaExistsRows[0]?.exists !== true) {
      throw new Error(
        `[tenant-schema-provisioner] Reconcile job ${job.id} requires existing schema ${job.schemaName}`,
      );
    }

    tableCount = await countTenantTables(queryRunner, job.schemaName);
    if (tableCount <= 0) {
      throw new Error(
        `[tenant-schema-provisioner] Reconcile job ${job.id} found empty schema ${job.schemaName}`,
      );
    }

    const tenantAwareEntries = SCHEMA_REGISTRY.filter((entry) =>
      TENANT_AWARE_SCHEMAS.has(entry.schema),
    );
    for (const entry of tenantAwareEntries) {
      await renewJobLease(queryRunner, job, lease);
      sourceHeads[entry.schema] = headToJson(
        await readLedgerHead(queryRunner, entry.schema, MIGRATION_LEDGER_TABLE),
      );
      tenantHeads[entry.schema] = headToJson(
        await readTenantHead(queryRunner, job.schemaName, entry.schema),
      );
      await grantTenantMigrationLedgerReadAccess(queryRunner, {
        tenantSchema: job.schemaName,
        sourceSchema: entry.schema,
      });
      // 2026-07-06 grant incident: fan-out-created tables are born
      // owner=superuser with an empty ACL — align owner + service DML from
      // the MODULE_SCHEMAS registry (idempotent) so reconcile also repairs
      // pre-existing drift.
      await assertTenantSchemaPrivileges(queryRunner, {
        tenantSchema: job.schemaName,
        sourceSchema: entry.schema,
      });
    }

    await renewJobLease(queryRunner, job, lease);
    const sensorAggregates = await ensureTenantSensorContinuousAggregateAuthority(
      queryRunner,
      job.schemaName,
    );
    await renewJobLease(queryRunner, job, lease);
    options.log({
      level: sensorAggregates.timescalePresent ? 'info' : 'warn',
      message: sensorAggregates.timescalePresent
        ? 'Sensor continuous-aggregate authority aligned'
        : 'TimescaleDB absent — sensor continuous-aggregate authority skipped',
      context: 'TenantSchemaProvisioner',
      jobId: job.id,
      tenantSchema: job.schemaName,
      aggregates: sensorAggregates.aggregates,
    });

    await grantTenantMessagingPartitionAuthority(queryRunner, {
      tenantSchema: job.schemaName,
    });

    await assertTenantPrivilegesVerified(queryRunner, job.schemaName, options.log);
    await assertSourceSchemaWriteGuardsVerified(queryRunner, options.log);

    await commitTenantSchemaEvidence(queryRunner, job, lease, {
      sourceHeads,
      tenantHeads,
      tableCount,
      failureResidue: {
        schemaName: job.schemaName,
        reconciled: true,
        capturedAt: new Date().toISOString(),
      },
    });

    options.log({
      level: 'info',
      message: 'Tenant schema provisioner reconciled existing tenant schema',
      context: 'TenantSchemaProvisioner',
      jobId: job.id,
      operationId: job.operationId,
      tenantId: job.tenantId,
      schemaName: job.schemaName,
      tableCount,
    });
  } catch (error: unknown) {
    const failureResidue = await collectFailureResidue(queryRunner, job).catch(
      (residueError: unknown) => ({
        residueCaptureFailed:
          residueError instanceof Error ? residueError.message : String(residueError),
      }),
    );
    await writeJobEvidence(queryRunner, job, lease, {
      status: 'FAILED',
      sourceHeads,
      tenantHeads,
      tableCount,
      failureResidue,
      errorMessage: error instanceof Error ? error.message : String(error),
    }).catch((writeError: unknown) => {
      options.log({
        level: 'error',
        message: 'Tenant schema provisioner failed to write reconcile failure evidence',
        context: 'TenantSchemaProvisioner',
        jobId: job.id,
        error: writeError instanceof Error ? writeError.message : String(writeError),
      });
    });
    throw error;
  } finally {
    await queryRunner.release();
    await control.destroy();
  }
}

async function processJob(
  job: TenantSchemaJob,
  options: TenantSchemaProvisionerOptions,
): Promise<void> {
  if (
    getTenantSchemaName(job.tenantId) !== job.schemaName ||
    !TENANT_SCHEMA_NAME_RE.test(job.schemaName)
  ) {
    throw new Error(
      `[tenant-schema-provisioner] Job ${job.id} has invalid tenant/schema pair: ${job.tenantId} -> ${job.schemaName}`,
    );
  }

  if (job.jobType === 'DELETE') {
    await processDeleteJob(job, options);
    return;
  }
  if (job.jobType === 'RECONCILE_EXISTING_SCHEMA') {
    await processReconcileJob(job, options);
    return;
  }

  const control = createControlDataSource(options.database);
  await control.initialize();
  const queryRunner = control.createQueryRunner();
  const lease = { leaseSeconds: options.leaseSeconds ?? DEFAULT_LEASE_SECONDS };
  const sourceHeads: Record<string, unknown> = {};
  const tenantHeads: Record<string, unknown> = {};
  let tableCount = 0;

  try {
    await queryRunner.connect();
    await assertTenantSchemaIdentityAvailable(queryRunner, job);
    await setJobStatus(queryRunner, job, 'CREATING_SCHEMA', lease);
    await queryRunner.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(job.schemaName)}`);

    const tenantAwareEntries = SCHEMA_REGISTRY.filter((entry) =>
      TENANT_AWARE_SCHEMAS.has(entry.schema),
    );
    for (const entry of tenantAwareEntries) {
      await setJobStatus(queryRunner, job, 'COPYING_TABLES', lease);
      const migrations = entry.migrationsGlob.map((glob) => resolve(options.root, glob));
      const entities = entry.entitiesGlob?.map((glob) => resolve(options.root, glob));
      const result = await runSchemaMigrations({
        schema: job.schemaName,
        migrations,
        ...(entities !== undefined ? { entities } : {}),
        database: options.database,
        log: options.log,
        migrationsTableName: tenantMigrationLedgerTable(entry.schema),
      });
      await renewJobLease(queryRunner, job, lease);

      sourceHeads[entry.schema] = headToJson(
        await readLedgerHead(queryRunner, entry.schema, MIGRATION_LEDGER_TABLE),
      );
      tenantHeads[entry.schema] = headToJson(
        result.head ?? (await readTenantHead(queryRunner, job.schemaName, entry.schema)),
      );

      await setJobStatus(queryRunner, job, 'APPLYING_GRANTS', lease);
      await grantTenantMigrationLedgerReadAccess(queryRunner, {
        tenantSchema: job.schemaName,
        sourceSchema: entry.schema,
      });
      // 2026-07-06 grant incident: without this, EVERY table of a freshly
      // provisioned tenant is owner=superuser with an empty ACL and the
      // owning services fail their first tenant query at runtime.
      await assertTenantSchemaPrivileges(queryRunner, {
        tenantSchema: job.schemaName,
        sourceSchema: entry.schema,
      });

      if (entry.postMigrationHardening !== undefined) {
        await setJobStatus(queryRunner, job, 'HARDENING_RLS', lease);
        await applyProvisionerHardening(
          queryRunner,
          job.schemaName,
          entry.postMigrationHardening,
          options.log,
        );
        await renewJobLease(queryRunner, job, lease);
      }
    }

    await setJobStatus(queryRunner, job, 'APPLYING_GRANTS', lease);
    const sensorAggregates = await ensureTenantSensorContinuousAggregateAuthority(
      queryRunner,
      job.schemaName,
    );
    await renewJobLease(queryRunner, job, lease);
    options.log({
      level: sensorAggregates.timescalePresent ? 'info' : 'warn',
      message: sensorAggregates.timescalePresent
        ? 'Sensor continuous-aggregate authority aligned'
        : 'TimescaleDB absent — sensor continuous-aggregate authority skipped',
      context: 'TenantSchemaProvisioner',
      jobId: job.id,
      tenantSchema: job.schemaName,
      aggregates: sensorAggregates.aggregates,
    });

    // DATA-HIGH-006: the messaging partition definer function
    // (platform.create_messaging_partition, owner messaging_schema_owner)
    // needs schema CREATE + messaging-relation ownership inside this tenant
    // schema. pg16 requires parent-table OWNERSHIP for PARTITION OF (proven
    // empirically; schema CREATE alone is not enough), and the fan-out above
    // created the clones under the bootstrap connection's role — re-own +
    // grant here so the first monthly partition for this tenant works
    // without any manual ceremony. Stage 010 backfills pre-existing schemas.
    await setJobStatus(queryRunner, job, 'APPLYING_GRANTS', lease);
    await grantTenantMessagingPartitionAuthority(queryRunner, {
      tenantSchema: job.schemaName,
    });

    await setJobStatus(queryRunner, job, 'SEEDING_LEDGER', lease);
    tableCount = await countTenantTables(queryRunner, job.schemaName);
    if (tableCount <= 0) {
      throw new Error(
        `[tenant-schema-provisioner] Tenant schema ${job.schemaName} has no base tables after fan-out`,
      );
    }

    await assertTenantPrivilegesVerified(queryRunner, job.schemaName, options.log);
    await assertSourceSchemaWriteGuardsVerified(queryRunner, options.log);

    await commitTenantSchemaEvidence(queryRunner, job, lease, {
      sourceHeads,
      tenantHeads,
      tableCount,
    });
    options.log({
      level: 'info',
      message: 'Tenant schema provisioner committed tenant schema',
      context: 'TenantSchemaProvisioner',
      jobId: job.id,
      operationId: job.operationId,
      tenantId: job.tenantId,
      schemaName: job.schemaName,
      tableCount,
    });
  } catch (error: unknown) {
    const failureResidue = await collectFailureResidue(queryRunner, job).catch(
      (residueError: unknown) => ({
        residueCaptureFailed:
          residueError instanceof Error ? residueError.message : String(residueError),
      }),
    );
    await writeJobEvidence(queryRunner, job, lease, {
      status: 'FAILED',
      sourceHeads,
      tenantHeads,
      tableCount,
      failureResidue,
      errorMessage: error instanceof Error ? error.message : String(error),
    }).catch((writeError: unknown) => {
      options.log({
        level: 'error',
        message: 'Tenant schema provisioner failed to write job failure evidence',
        context: 'TenantSchemaProvisioner',
        jobId: job.id,
        error: writeError instanceof Error ? writeError.message : String(writeError),
      });
    });
    throw error;
  } finally {
    await queryRunner.release();
    await control.destroy();
  }
}

export async function runTenantSchemaProvisioner(
  options: TenantSchemaProvisionerOptions,
): Promise<number> {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const leaseSeconds = options.leaseSeconds ?? DEFAULT_LEASE_SECONDS;
  const provisionerId =
    options.provisionerId ?? `aqua-db-migrate:${process.pid}:${Date.now().toString(36)}`;

  do {
    const dataSource = createControlDataSource(options.database);
    await dataSource.initialize();
    const queryRunner = dataSource.createQueryRunner();
    let job: TenantSchemaJob | null = null;

    try {
      await queryRunner.connect();
      await queryRunner.startTransaction();
      job = await claimNextJob(queryRunner, provisionerId, leaseSeconds);
      await queryRunner.commitTransaction();
    } catch (error) {
      await queryRunner.rollbackTransaction().catch(() => undefined);
      throw error;
    } finally {
      await queryRunner.release();
      await dataSource.destroy();
    }

    if (!job) {
      if (options.once) {
        options.log({
          level: 'info',
          message: 'Tenant schema provisioner found no pending jobs',
          context: 'TenantSchemaProvisioner',
        });
        return 0;
      }
      await new Promise((resolvePoll) => setTimeout(resolvePoll, pollIntervalMs));
      continue;
    }

    try {
      await processJob(job, options);
    } catch (error: unknown) {
      options.log({
        level: 'error',
        message: 'Tenant schema provisioner job failed',
        context: 'TenantSchemaProvisioner',
        jobId: job.id,
        operationId: job.operationId,
        tenantId: job.tenantId,
        schemaName: job.schemaName,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      if (options.once) return 1;
    }
  } while (!options.once);

  return 0;
}
