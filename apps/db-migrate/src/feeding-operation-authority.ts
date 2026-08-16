import {
  queryRowsNormalized,
  type TenantSchemaMappingRow,
  verifyTenantSchemaMappingRows,
} from '@aquaculture/backend-common/database';
import {
  FEEDING_JOB_CATALOG,
  FEEDING_JOB_CATALOG_CANONICAL_JSON,
  FEEDING_JOB_CATALOG_DIGEST,
  FEEDING_JOB_CATALOG_REVISION,
} from '@aquaculture/feeding-contracts';
import {
  canonicalJsonStringify,
  createCanonicalJsonDocumentV1,
} from '@aquaculture/shared-contracts';
import { QueryRunner } from 'typeorm';

interface CatalogIdentity {
  revision: string;
  digest: string;
  jobCount: string;
  admissionGeneration: string;
}

interface CatalogRootRow {
  revision: string;
  canonicalJson: string;
  jobCount: string;
}

interface CatalogProjectionDrift {
  missing: string;
  extra: string;
  changed: string;
}

interface AdmissionRow {
  generation: string;
  activeDigest: string;
}

interface AuthorityDrift {
  missingActiveTenants: string;
  unexpectedActiveAuthorities: string;
  wrongCatalogAuthorities: string;
}

interface WriterAuthorityRow {
  tenantId: string;
  generation: string;
  state: 'active' | 'revoked';
  catalogDigest: string;
}

interface WriterAuthorityTransitionRow extends WriterAuthorityRow {
  changedBy: string;
  evidence: unknown;
  transitionedAt: Date;
  mutated: boolean;
}

export interface FeedingAuthorityEvidence {
  readonly actor: string;
  readonly operationId: string;
  readonly reason:
    | 'release_convergence'
    | 'tenant_provision'
    | 'tenant_reconcile'
    | 'tenant_delete';
}

function requireAuthorityTransaction(queryRunner: QueryRunner): void {
  if (!queryRunner.isTransactionActive) {
    throw new Error('[feeding-authority] Mutation requires one explicit release transaction');
  }
}

function desiredCatalogEntries(): Array<Record<string, unknown>> {
  return FEEDING_JOB_CATALOG.map((definition) => ({
    catalogDigest: FEEDING_JOB_CATALOG_DIGEST,
    id: definition.id,
    capability: definition.capability,
    scheduleKind: definition.scheduleKind,
    clockProfile: definition.clockProfile,
    targetCardinality: definition.targetCardinality,
    timezoneSource: definition.timezoneSource,
    leaseSeconds: definition.leaseSeconds,
    enabled: definition.enabled,
    definition,
  }));
}

async function verifyCatalogArtifact(queryRunner: QueryRunner, desiredJson: string): Promise<void> {
  const roots = queryRowsNormalized<CatalogRootRow>(
    await queryRunner.query(
      `SELECT revision, "canonicalJson", "jobCount"::text AS "jobCount"
         FROM farm.feeding_catalog_revisions
        WHERE digest = $1`,
      [FEEDING_JOB_CATALOG_DIGEST],
    ),
  );
  const root = roots[0];
  if (
    !root ||
    root.revision !== FEEDING_JOB_CATALOG_REVISION ||
    root.canonicalJson !== FEEDING_JOB_CATALOG_CANONICAL_JSON ||
    Number.parseInt(root.jobCount, 10) !== FEEDING_JOB_CATALOG.length
  ) {
    throw new Error('[feeding-authority] Catalog digest root does not match canonical bytes');
  }

  const driftRows = queryRowsNormalized<CatalogProjectionDrift>(
    await queryRunner.query(
      `WITH desired AS (
         SELECT *
           FROM jsonb_to_recordset($1::jsonb) AS d(
             "catalogDigest" varchar,
             id varchar,
             capability varchar,
             "scheduleKind" varchar,
             "clockProfile" varchar,
             "targetCardinality" varchar,
             "timezoneSource" varchar,
             "leaseSeconds" integer,
             enabled boolean,
             definition jsonb
           )
       )
       SELECT
         (SELECT count(*)::text FROM desired d
           WHERE NOT EXISTS (
             SELECT 1 FROM farm.feeding_job_catalog_entries e
              WHERE e."catalogDigest" = d."catalogDigest" AND e.id = d.id
           )) AS missing,
         (SELECT count(*)::text FROM farm.feeding_job_catalog_entries e
           WHERE e."catalogDigest" = $2
             AND NOT EXISTS (SELECT 1 FROM desired d WHERE d.id = e.id)) AS extra,
         (SELECT count(*)::text
            FROM desired d
            JOIN farm.feeding_job_catalog_entries e
              ON e."catalogDigest" = d."catalogDigest" AND e.id = d.id
           WHERE (e.capability, e."scheduleKind", e."clockProfile", e."targetCardinality", e."timezoneSource",
                  e."leaseSeconds", e.enabled, e.definition)
             IS DISTINCT FROM
                 (d.capability, d."scheduleKind", d."clockProfile", d."targetCardinality", d."timezoneSource",
                  d."leaseSeconds", d.enabled, d.definition)) AS changed`,
      [desiredJson, FEEDING_JOB_CATALOG_DIGEST],
    ),
  );
  const drift = driftRows[0];
  if (
    !drift ||
    Number.parseInt(drift.missing, 10) !== 0 ||
    Number.parseInt(drift.extra, 10) !== 0 ||
    Number.parseInt(drift.changed, 10) !== 0
  ) {
    throw new Error(
      `[feeding-authority] Immutable catalog artifact set equality failed: ${JSON.stringify(drift)}`,
    );
  }
}

/**
 * Publishes one content-addressed catalog artifact.
 *
 * An existing digest is verification-only: it is never repaired, updated, or
 * deleted. A partial or mismatched artifact therefore fails the release rather
 * than laundering historical corruption into a valid-looking root.
 */
export async function projectFeedingJobCatalog(queryRunner: QueryRunner): Promise<number> {
  requireAuthorityTransaction(queryRunner);
  const desired = desiredCatalogEntries();
  const desiredJson = JSON.stringify(desired);

  await queryRunner.query(`LOCK TABLE farm.feeding_catalog_revisions IN SHARE ROW EXCLUSIVE MODE`);
  await queryRunner.query(
    `LOCK TABLE farm.feeding_job_catalog_entries IN SHARE ROW EXCLUSIVE MODE`,
  );
  const existingRows = queryRowsNormalized<{ exists: boolean }>(
    await queryRunner.query(
      `SELECT EXISTS (
         SELECT 1 FROM farm.feeding_catalog_revisions WHERE digest = $1
       ) AS exists`,
      [FEEDING_JOB_CATALOG_DIGEST],
    ),
  );

  if (existingRows[0]?.exists === true) {
    await verifyCatalogArtifact(queryRunner, desiredJson);
    return desired.length;
  }

  await queryRunner.query(
    `INSERT INTO farm.feeding_catalog_revisions (
       digest, revision, "canonicalJson", "jobCount"
     ) VALUES ($1, $2, $3, $4)`,
    [
      FEEDING_JOB_CATALOG_DIGEST,
      FEEDING_JOB_CATALOG_REVISION,
      FEEDING_JOB_CATALOG_CANONICAL_JSON,
      desired.length,
    ],
  );
  await queryRunner.query(
    `INSERT INTO farm.feeding_job_catalog_entries (
       "catalogDigest", id, capability, "scheduleKind", "clockProfile", "targetCardinality", "timezoneSource",
       "leaseSeconds", enabled, definition
     )
     SELECT "catalogDigest", id, capability, "scheduleKind", "clockProfile", "targetCardinality", "timezoneSource",
            "leaseSeconds", enabled, definition
       FROM jsonb_to_recordset($1::jsonb) AS d(
         "catalogDigest" varchar,
         id varchar,
         capability varchar,
         "scheduleKind" varchar,
         "clockProfile" varchar,
         "targetCardinality" varchar,
         "timezoneSource" varchar,
         "leaseSeconds" integer,
         enabled boolean,
         definition jsonb
       )`,
    [desiredJson],
  );
  await verifyCatalogArtifact(queryRunner, desiredJson);
  return desired.length;
}

function admissionEvidenceJson(evidence: FeedingAuthorityEvidence, generation: number): string {
  return JSON.stringify({
    actor: evidence.actor,
    operationId: evidence.operationId,
    reason: evidence.reason,
    catalogRevision: FEEDING_JOB_CATALOG_REVISION,
    catalogDigest: FEEDING_JOB_CATALOG_DIGEST,
    catalogJobCount: FEEDING_JOB_CATALOG.length,
    admissionGeneration: generation,
  });
}

/** Atomically moves the singleton active-catalog pointer using generation CAS. */
export async function admitFeedingJobCatalog(
  queryRunner: QueryRunner,
  evidence: FeedingAuthorityEvidence,
): Promise<number> {
  requireAuthorityTransaction(queryRunner);
  const rows = queryRowsNormalized<AdmissionRow>(
    await queryRunner.query(
      `SELECT generation::text AS generation, "activeDigest"::text AS "activeDigest"
         FROM farm.feeding_catalog_admission
        WHERE authority = 'feeding'`,
    ),
  );
  const current = rows[0];
  const currentGeneration = current ? Number.parseInt(current.generation, 10) : null;
  const proposedGeneration =
    currentGeneration === null
      ? 1
      : current?.activeDigest === FEEDING_JOB_CATALOG_DIGEST
        ? currentGeneration
        : currentGeneration + 1;
  const admitted = queryRowsNormalized<{ generation: string }>(
    await queryRunner.query(
      `SELECT farm.admit_feeding_catalog($1, $2, $3, $4, $5::jsonb)::text AS generation`,
      [
        currentGeneration,
        current?.activeDigest ?? null,
        FEEDING_JOB_CATALOG_DIGEST,
        evidence.actor,
        admissionEvidenceJson(evidence, proposedGeneration),
      ],
    ),
  );
  const admittedGeneration = Number.parseInt(admitted[0]?.generation ?? '', 10);
  if (!Number.isInteger(admittedGeneration) || admittedGeneration !== proposedGeneration) {
    throw new Error(
      '[feeding-authority] Database returned an invalid catalog admission generation',
    );
  }
  return admittedGeneration;
}

async function catalogIdentity(queryRunner: QueryRunner): Promise<CatalogIdentity> {
  const rows = queryRowsNormalized<CatalogIdentity>(
    await queryRunner.query(
      `SELECT root.revision,
              root.digest::text AS digest,
              root."jobCount"::text AS "jobCount",
              admission.generation::text AS "admissionGeneration"
         FROM farm.feeding_catalog_admission admission
         JOIN farm.feeding_catalog_revisions root
           ON root.digest = admission."activeDigest"
        WHERE admission.authority = 'feeding'`,
    ),
  );
  const identity = rows[0];
  if (!identity) {
    throw new Error('[feeding-authority] No admitted catalog root exists');
  }
  return identity;
}

function writerAuthorityEvidenceJson(
  evidence: FeedingAuthorityEvidence,
  identity: CatalogIdentity,
  current: WriterAuthorityRow | undefined,
  writerGeneration: number,
  writerState: 'active' | 'revoked',
): string {
  return canonicalJsonStringify(
    createCanonicalJsonDocumentV1({
      actor: evidence.actor,
      operationId: evidence.operationId,
      reason: evidence.reason,
      catalogRevision: identity.revision,
      catalogDigest: identity.digest,
      catalogJobCount: Number.parseInt(identity.jobCount, 10),
      admissionGeneration: Number.parseInt(identity.admissionGeneration, 10),
      expectedWriterGeneration: current ? Number.parseInt(current.generation, 10) : null,
      expectedWriterState: current?.state ?? null,
      expectedWriterCatalogDigest: current?.catalogDigest ?? null,
      writerGeneration,
      writerState,
      writerTransition: writerState === 'active' ? 'activated' : 'revoked',
    }),
  );
}

async function currentWriterAuthority(
  queryRunner: QueryRunner,
  tenantId: string,
): Promise<WriterAuthorityRow | undefined> {
  const rows = queryRowsNormalized<WriterAuthorityRow>(
    await queryRunner.query(
      `SELECT "tenantId"::text AS "tenantId", generation::text AS generation,
              state, "catalogDigest"::text AS "catalogDigest"
         FROM farm.feeding_writer_authority
        WHERE "tenantId" = $1::uuid`,
      [tenantId],
    ),
  );
  return rows[0];
}

async function transitionWriterAuthority(
  queryRunner: QueryRunner,
  tenantId: string,
  targetState: 'active' | 'revoked',
  evidence: FeedingAuthorityEvidence,
): Promise<WriterAuthorityTransitionRow> {
  const identity = await catalogIdentity(queryRunner);
  const current = await currentWriterAuthority(queryRunner, tenantId);
  if (!current && targetState === 'revoked') {
    throw new Error(`[feeding-authority] Cannot revoke absent writer authority for ${tenantId}`);
  }
  const currentGeneration = current ? Number.parseInt(current.generation, 10) : null;
  if (current && !Number.isSafeInteger(currentGeneration)) {
    throw new Error(`[feeding-authority] Invalid writer generation for ${tenantId}`);
  }
  const idempotent = current?.state === targetState && current.catalogDigest === identity.digest;
  const writerGeneration =
    currentGeneration === null ? 1 : idempotent ? currentGeneration : currentGeneration + 1;
  const rows = queryRowsNormalized<WriterAuthorityTransitionRow>(
    await queryRunner.query(
      `SELECT "tenantId"::text AS "tenantId", generation::text AS generation,
              state, "catalogDigest"::text AS "catalogDigest", "changedBy",
              evidence, "transitionedAt", mutated
         FROM farm.transition_feeding_writer_authority(
           $1::uuid, $2::bigint, $3::varchar, $4::varchar,
           $5::varchar, $6::varchar, $7::varchar, $8::jsonb
         )`,
      [
        tenantId,
        currentGeneration,
        current?.state ?? null,
        current?.catalogDigest ?? null,
        identity.digest,
        targetState,
        evidence.actor,
        writerAuthorityEvidenceJson(evidence, identity, current, writerGeneration, targetState),
      ],
    ),
  );
  const transitioned = rows[0];
  if (
    !transitioned ||
    transitioned.tenantId !== tenantId ||
    Number.parseInt(transitioned.generation, 10) !== writerGeneration ||
    transitioned.state !== targetState ||
    transitioned.catalogDigest !== identity.digest ||
    transitioned.mutated !== !idempotent
  ) {
    throw new Error(`[feeding-authority] Writer transition returned invalid state for ${tenantId}`);
  }
  return transitioned;
}

export async function activateFeedingWriterAuthority(
  queryRunner: QueryRunner,
  tenantId: string,
  evidence: FeedingAuthorityEvidence,
): Promise<void> {
  requireAuthorityTransaction(queryRunner);
  await transitionWriterAuthority(queryRunner, tenantId, 'active', evidence);
}

/** Revokes, but never erases, a tenant authority and advances its fence. */
export async function revokeFeedingWriterAuthority(
  queryRunner: QueryRunner,
  tenantId: string,
  evidence: FeedingAuthorityEvidence,
): Promise<void> {
  requireAuthorityTransaction(queryRunner);
  const current = await currentWriterAuthority(queryRunner, tenantId);
  if (!current || current.state === 'revoked') return;
  await transitionWriterAuthority(queryRunner, tenantId, 'revoked', evidence);
}

/** Compiles and admits the catalog, then proves active-tenant set equality. */
export async function reconcileFeedingWriterAuthorities(
  queryRunner: QueryRunner,
  evidence: FeedingAuthorityEvidence,
): Promise<{ activeTenantCount: number; catalogJobCount: number }> {
  requireAuthorityTransaction(queryRunner);
  const catalogJobCount = await projectFeedingJobCatalog(queryRunner);
  await admitFeedingJobCatalog(queryRunner, evidence);
  await queryRunner.query(
    `SELECT pg_catalog.pg_advisory_xact_lock(
       pg_catalog.hashtextextended('feeding-writer-authority-reconcile', 0)
     )`,
  );
  await queryRunner.query(`LOCK TABLE admin.tenant_schemas IN SHARE MODE`);

  const mappingRows = queryRowsNormalized<TenantSchemaMappingRow>(
    await queryRunner.query(
      `SELECT schema_name, tenant_id::text AS tenant_id, schema_exists, committed_proof
         FROM platform.list_active_tenant_schema_mappings()
        ORDER BY schema_name`,
    ),
  );
  const activeTenantMappings = verifyTenantSchemaMappingRows(mappingRows, 'active');
  const activeTenantIds = activeTenantMappings.map((mapping) => mapping.tenantId);
  for (const mapping of activeTenantMappings) {
    await activateFeedingWriterAuthority(queryRunner, mapping.tenantId, evidence);
  }

  const unexpected = queryRowsNormalized<{ tenantId: string }>(
    await queryRunner.query(
      `SELECT a."tenantId"::text AS "tenantId"
         FROM farm.feeding_writer_authority a
        WHERE a.state = 'active'
          AND NOT (a."tenantId" = ANY($1::uuid[]))
        ORDER BY a."tenantId"`,
      [activeTenantIds],
    ),
  );
  for (const row of unexpected) {
    await revokeFeedingWriterAuthority(queryRunner, row.tenantId, evidence);
  }

  const identity = await catalogIdentity(queryRunner);

  const driftRows = queryRowsNormalized<AuthorityDrift>(
    await queryRunner.query(
      `SELECT
         (SELECT count(*)::text FROM pg_catalog.unnest($2::uuid[]) expected("tenantId")
           WHERE NOT EXISTS (
               SELECT 1 FROM farm.feeding_writer_authority a
                WHERE a."tenantId" = expected."tenantId" AND a.state = 'active'
             )) AS "missingActiveTenants",
         (SELECT count(*)::text FROM farm.feeding_writer_authority a
           WHERE a.state = 'active'
             AND NOT (a."tenantId" = ANY($2::uuid[]))) AS "unexpectedActiveAuthorities",
         (SELECT count(*)::text FROM farm.feeding_writer_authority a
           WHERE a.state = 'active' AND a."catalogDigest" <> $1)
           AS "wrongCatalogAuthorities"`,
      [identity.digest, activeTenantIds],
    ),
  );
  const drift = driftRows[0];
  if (
    !drift ||
    Number.parseInt(drift.missingActiveTenants, 10) !== 0 ||
    Number.parseInt(drift.unexpectedActiveAuthorities, 10) !== 0 ||
    Number.parseInt(drift.wrongCatalogAuthorities, 10) !== 0
  ) {
    throw new Error(
      `[feeding-authority] Active tenant/catalog set equality failed: ${JSON.stringify(drift)}`,
    );
  }
  return { activeTenantCount: activeTenantMappings.length, catalogJobCount };
}
