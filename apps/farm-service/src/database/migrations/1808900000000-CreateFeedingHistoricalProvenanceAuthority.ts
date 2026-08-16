import type { MigrationInterface, QueryRunner } from 'typeorm';

import {
  FEEDING_HISTORICAL_PROVENANCE_MIGRATION_SNAPSHOT_DIGEST_V1,
  FEEDING_HISTORICAL_PROVENANCE_MIGRATION_SNAPSHOT_V1,
} from './feeding-historical-provenance-authority.v1';

const PROVENANCE_CATALOG_DIGEST =
  'e770e83b10850103a9f344d196faeeb20774a07c51800b59ca320b687605a6bc';

if (FEEDING_HISTORICAL_PROVENANCE_MIGRATION_SNAPSHOT_DIGEST_V1 !== PROVENANCE_CATALOG_DIGEST) {
  throw new Error('Feeding historical provenance migration snapshot digest mismatch');
}

const AUTHORITY = FEEDING_HISTORICAL_PROVENANCE_MIGRATION_SNAPSHOT_V1;
const ROOT_DIGEST = AUTHORITY.journal.rootDigest;

function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function sqlTextArray(values: readonly string[]): string {
  return `ARRAY[${values.map(sqlLiteral).join(', ')}]::text[]`;
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function journalColumnDefinitions(): string {
  return AUTHORITY.journal.columns
    .map((column) => {
      const defaultClause =
        'defaultExpression' in column ? ` DEFAULT ${column.defaultExpression}` : '';
      return `${quoteIdentifier(column.name)} ${column.type}${
        column.nullable ? '' : ' NOT NULL'
      }${defaultClause}`;
    })
    .join(',\n        ');
}

function payloadValidationCases(): string {
  return AUTHORITY.eventDefinitions
    .map(
      (definition) =>
        `WHEN ${sqlLiteral(definition.eventKind)} THEN
           p_subject_kind = ${sqlLiteral(definition.subjectKind)}
           AND ARRAY(
                 SELECT key
                   FROM jsonb_object_keys(p_payload) AS keys(key)
                  ORDER BY key COLLATE "C"
               ) = ${sqlTextArray(definition.payloadKeys)}`,
    )
    .join('\n        ');
}

interface ProvenanceTransitionV1 {
  readonly predecessorEventKind: string | null;
  readonly eventKind: string;
  readonly predecessorDigestPayloadKey: string | null;
  readonly continuityPayloadKeys: readonly string[];
}

interface ProvenanceSubjectTransitionAuthorityV1 {
  readonly subjectKind: string;
  readonly transitions: readonly ProvenanceTransitionV1[];
}

const PROVENANCE_TRANSITION_AUTHORITIES = AUTHORITY.transitionGraph
  .subjects as readonly ProvenanceSubjectTransitionAuthorityV1[];

function transitionPredicate(transition: ProvenanceTransitionV1): string {
  const predecessor =
    transition.predecessorEventKind === null
      ? 'prior_event_kind IS NULL'
      : `prior_event_kind = ${sqlLiteral(transition.predecessorEventKind)}`;
  return `(${predecessor} AND p_event_kind = ${sqlLiteral(transition.eventKind)})`;
}

function legalTransitionPredicate(): string {
  return PROVENANCE_TRANSITION_AUTHORITIES.map(
    (authority) =>
      `(p_subject_kind = ${sqlLiteral(authority.subjectKind)} AND (
          ${authority.transitions.map(transitionPredicate).join('\n          OR ')}
        ))`,
  ).join('\n        OR ');
}

function predecessorDigestMismatchPredicate(): string {
  const predicates = PROVENANCE_TRANSITION_AUTHORITIES.flatMap((authority) =>
    authority.transitions.flatMap((transition) =>
      transition.predecessorDigestPayloadKey === null
        ? []
        : [
            `(p_subject_kind = ${sqlLiteral(authority.subjectKind)}
              AND ${transitionPredicate(transition)}
              AND p_payload->>${sqlLiteral(transition.predecessorDigestPayloadKey)}
                  IS DISTINCT FROM prior_digest)`,
          ],
    ),
  );
  if (predicates.length === 0) {
    throw new Error('Feeding provenance transition authority has no predecessor-digest binding');
  }
  return predicates.join('\n        OR ');
}

function continuityMismatchPredicate(): string {
  const predicates = PROVENANCE_TRANSITION_AUTHORITIES.flatMap((authority) =>
    authority.transitions.flatMap((transition) =>
      transition.continuityPayloadKeys.map(
        (key) =>
          `(p_subject_kind = ${sqlLiteral(authority.subjectKind)}
            AND ${transitionPredicate(transition)}
            AND p_payload->>${sqlLiteral(key)} IS DISTINCT FROM prior_payload->>${sqlLiteral(key)})`,
      ),
    ),
  );
  if (predicates.length === 0) {
    throw new Error('Feeding provenance transition authority has no payload-continuity binding');
  }
  return predicates.join('\n        OR ');
}

interface DatabaseIdentity {
  readonly schema: string;
  readonly owner: string;
}

/**
 * Creates one tenant-scoped, append-only provenance authority for both legacy
 * execution attribution and day-plan growth. Historical meaning is never
 * inferred from the current protocol row: ambiguous facts become journaled
 * quarantine events and can only move forward through a typed resolution.
 */
export class CreateFeedingHistoricalProvenanceAuthority1808900000000 implements MigrationInterface {
  name = 'CreateFeedingHistoricalProvenanceAuthority1808900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '600s'`);

    const presence: Array<{ plans: string | null; records: string | null }> =
      await queryRunner.query(`
        SELECT to_regclass('feeding_day_plans')::text AS plans,
               to_regclass('feeding_records')::text AS records
      `);
    if (!presence[0]?.plans && !presence[0]?.records) return;
    if (!presence[0]?.plans || !presence[0]?.records) {
      throw new Error(
        '[feeding-historical-provenance] feeding_day_plans and feeding_records must exist together',
      );
    }

    const identityRows: DatabaseIdentity[] = await queryRunner.query(`
      SELECT current_schema() AS schema, current_user AS owner
    `);
    const identity = identityRows[0];
    if (!identity?.schema || !identity.owner) {
      throw new Error('[feeding-historical-provenance] cannot resolve tenant schema owner');
    }
    const schema = quoteIdentifier(identity.schema);
    const qualified = (name: string): string => `${schema}.${quoteIdentifier(name)}`;
    const journal = qualified(AUTHORITY.journal.relation);
    const appendFunction = qualified(AUTHORITY.journal.appendFunction);
    const digestFunction = qualified(AUTHORITY.journal.digestFunction);
    const canonicalFunction = qualified('canonical_feeding_historical_json_v1');
    const payloadValidator = qualified('is_valid_feeding_historical_payload_v1');
    const tenantIsolation = AUTHORITY.journal.tenantIsolation;

    await queryRunner.query(`
      ALTER TABLE "feeding_day_plans"
        ADD COLUMN IF NOT EXISTS "growthPolicyVersion" smallint,
        ADD COLUMN IF NOT EXISTS "growthApplicationMode" varchar(16),
        ADD COLUMN IF NOT EXISTS "rollupAppliedKg" numeric(12,3) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS "rollupGrowthKg" numeric(12,3) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS "rollupLastRunAt" TIMESTAMP WITH TIME ZONE
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS ${journal} (
        ${journalColumnDefinitions()},
        CONSTRAINT "PK_feeding_historical_provenance_events" PRIMARY KEY ("eventId"),
        CONSTRAINT "UQ_feeding_historical_provenance_sequence"
          UNIQUE ("tenantId", "subjectKind", "subjectId", sequence),
        CONSTRAINT "UQ_feeding_historical_provenance_idempotency"
          UNIQUE ("tenantId", "idempotencyKey"),
        CONSTRAINT "UQ_feeding_historical_provenance_digest" UNIQUE ("eventDigest"),
        CONSTRAINT "CHK_feeding_historical_provenance_subject"
          CHECK ("subjectKind" = ANY (${sqlTextArray(AUTHORITY.subjectKinds)})),
        CONSTRAINT "CHK_feeding_historical_provenance_digest_shape"
          CHECK (
            "prevDigest" ~ '^[0-9a-f]{64}$'
            AND "eventDigest" ~ '^[0-9a-f]{64}$'
            AND "catalogDigest" ~ '^[0-9a-f]{64}$'
          ),
        CONSTRAINT "CHK_feeding_historical_provenance_sequence" CHECK (sequence > 0),
        CONSTRAINT "CHK_feeding_historical_provenance_catalog"
          CHECK (
            "schemaVersion" = ${sqlLiteral(AUTHORITY.schemaVersion)}
            AND "catalogDigest" = ${sqlLiteral(PROVENANCE_CATALOG_DIGEST)}
          )
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_feeding_historical_provenance_subject"
        ON ${journal} ("tenantId", "subjectKind", "subjectId", sequence DESC)
    `);

    // The accepted payload is a restricted RFC-8785 subset: ASCII catalog
    // keys and scalar string/null values. Quantities are fixed-scale strings,
    // so PostgreSQL numeric rendering can never create a cross-client hash fork.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION ${canonicalFunction}(p_value jsonb)
      RETURNS text
      LANGUAGE sql
      IMMUTABLE STRICT PARALLEL SAFE
      SET search_path = pg_catalog
      AS $function$
        SELECT CASE jsonb_typeof(p_value)
          WHEN 'null' THEN 'null'
          WHEN 'boolean' THEN p_value::text
          WHEN 'number' THEN p_value::text
          WHEN 'string' THEN p_value::text
          WHEN 'array' THEN '[' || COALESCE((
            SELECT string_agg(${canonicalFunction}(entry.value), ',' ORDER BY entry.ordinality)
              FROM jsonb_array_elements(p_value) WITH ORDINALITY AS entry(value, ordinality)
          ), '') || ']'
          WHEN 'object' THEN '{' || COALESCE((
            SELECT string_agg(
                     to_jsonb(entry.key)::text || ':' || ${canonicalFunction}(entry.value),
                     ',' ORDER BY entry.key COLLATE "C"
                   )
              FROM jsonb_each(p_value) AS entry(key, value)
          ), '') || '}'
          ELSE NULL
        END
      $function$
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION ${payloadValidator}(
        p_subject_kind text,
        p_event_kind text,
        p_payload jsonb
      ) RETURNS boolean
      LANGUAGE plpgsql
      IMMUTABLE STRICT PARALLEL SAFE
      SET search_path = pg_catalog
      AS $function$
      DECLARE
        valid_shape boolean;
      BEGIN
        IF jsonb_typeof(p_payload) <> 'object'
           OR octet_length(p_payload::text) > ${AUTHORITY.journal.maxPayloadBytes}
           OR EXISTS (
             SELECT 1 FROM jsonb_each(p_payload) AS field(key, value)
              WHERE jsonb_typeof(field.value) NOT IN ('string', 'null')
           ) THEN
          RETURN false;
        END IF;
        IF p_payload->>'schemaVersion' IS DISTINCT FROM ${sqlLiteral(AUTHORITY.schemaVersion)} THEN
          RETURN false;
        END IF;

        valid_shape := CASE p_event_kind
        ${payloadValidationCases()}
        ELSE false
        END;
        IF NOT valid_shape THEN RETURN false; END IF;

        IF p_event_kind IN ('ATTRIBUTION_ASSERTED', 'ATTRIBUTION_RESOLVED') THEN
          RETURN p_payload->>'sourceKind' = ANY (${sqlTextArray(AUTHORITY.vocabularies.sourceKinds)})
             AND p_payload->>'locationType' = ANY (${sqlTextArray(AUTHORITY.vocabularies.locationTypes)})
             AND p_payload->>'sourceExecutionId' ~* '^[0-9a-f-]{36}$'
             AND p_payload->>'batchId' ~* '^[0-9a-f-]{36}$'
             AND p_payload->>'batchLocationId' ~* '^[0-9a-f-]{36}$'
             AND p_payload->>'equipmentId' ~* '^[0-9a-f-]{36}$'
             AND p_payload->>'originalRecordDigest' ~ '^[0-9a-f]{64}$';
        ELSIF p_event_kind = 'ATTRIBUTION_QUARANTINED' THEN
          RETURN p_payload->>'sourceKind' = ANY (${sqlTextArray(AUTHORITY.vocabularies.sourceKinds)})
             AND p_payload->>'reasonCode' = ANY (${sqlTextArray(
               AUTHORITY.vocabularies.attributionQuarantineReasons,
             )})
             AND p_payload->>'sourceExecutionId' ~* '^[0-9a-f-]{36}$'
             AND p_payload->>'originalRecordDigest' ~ '^[0-9a-f]{64}$';
        ELSIF p_event_kind IN ('GROWTH_POLICY_ASSERTED', 'GROWTH_POLICY_RESOLVED') THEN
          RETURN p_payload->>'policyVersion' = '1'
             AND p_payload->>'growthApplicationMode' = ANY (${sqlTextArray(
               AUTHORITY.vocabularies.growthApplicationModes,
             )})
             AND p_payload->>'proofKind' = ANY (${sqlTextArray(
               AUTHORITY.vocabularies.growthPolicyProofKinds,
             )})
             AND p_payload->>'expectedFcr' ~ '^[0-9]+\\.[0-9]{6}$'
             AND (p_payload->>'expectedFcr')::numeric > 0;
        ELSIF p_event_kind = 'GROWTH_POLICY_QUARANTINED' THEN
          RETURN p_payload->>'reasonCode' = ANY (${sqlTextArray(
            AUTHORITY.vocabularies.growthQuarantineReasons,
          )});
        ELSIF p_event_kind = 'GROWTH_APPLIED' THEN
          RETURN p_payload->>'applicationMode' = ANY (${sqlTextArray(
            AUTHORITY.vocabularies.growthEventApplicationModes,
          )})
             AND p_payload->>'expectedFcr' ~ '^[0-9]+\\.[0-9]{6}$'
             AND p_payload->>'feedDeltaKg' ~ '^-?[0-9]+\\.[0-9]{3}$'
             AND p_payload->>'growthDeltaKg' ~ '^-?[0-9]+\\.[0-9]{3}$'
             AND (p_payload->>'expectedFcr')::numeric > 0
             AND round(
                   (p_payload->>'feedDeltaKg')::numeric /
                   (p_payload->>'expectedFcr')::numeric,
                   3
                 ) = (p_payload->>'growthDeltaKg')::numeric;
        END IF;
        RETURN false;
      EXCEPTION WHEN data_exception THEN
        RETURN false;
      END
      $function$
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION ${digestFunction}(
        p_tenant_id uuid,
        p_subject_kind text,
        p_subject_id uuid,
        p_sequence bigint,
        p_prev_digest text,
        p_event_kind text,
        p_payload_canonical text,
        p_operation_id text,
        p_idempotency_key text,
        p_recorded_at timestamptz,
        p_recorded_by text
      ) RETURNS text
      LANGUAGE sql
      IMMUTABLE STRICT PARALLEL SAFE
      SET search_path = pg_catalog
      AS $function$
        SELECT encode(pg_catalog.sha256(convert_to(${canonicalFunction}(jsonb_build_object(
          'catalogDigest', ${sqlLiteral(PROVENANCE_CATALOG_DIGEST)},
          'domain', ${sqlLiteral(AUTHORITY.journal.hashDomain)},
          'eventKind', p_event_kind,
          'idempotencyKey', p_idempotency_key,
          'operationId', p_operation_id,
          'payload', p_payload_canonical,
          'prevDigest', p_prev_digest,
          'recordedAt', to_char(
            p_recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
          ),
          'recordedBy', p_recorded_by,
          'schemaVersion', ${sqlLiteral(AUTHORITY.schemaVersion)},
          'sequence', p_sequence::text,
          'subjectId', p_subject_id::text,
          'subjectKind', p_subject_kind,
          'tenantId', p_tenant_id::text
        )), 'UTF8')), 'hex')
      $function$
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION ${qualified('reject_feeding_historical_journal_mutation_v1')}()
      RETURNS trigger
      LANGUAGE plpgsql
      SET search_path = pg_catalog
      AS $function$
      BEGIN
        IF TG_OP = 'INSERT'
           AND current_user = ${sqlLiteral(identity.owner)}
           AND current_setting('aqua.feeding_historical_append_digest', true) =
               ${sqlLiteral(PROVENANCE_CATALOG_DIGEST)} THEN
          RETURN NEW;
        END IF;
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'feeding historical provenance journal is append-function-only';
      END
      $function$
    `);
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS "TRG_feeding_historical_journal_immutable" ON ${journal};
      CREATE TRIGGER "TRG_feeding_historical_journal_immutable"
      BEFORE INSERT OR UPDATE OR DELETE ON ${journal}
      FOR EACH ROW EXECUTE FUNCTION ${qualified('reject_feeding_historical_journal_mutation_v1')}()
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION ${appendFunction}(
        p_tenant_id uuid,
        p_subject_kind text,
        p_subject_id uuid,
        p_event_kind text,
        p_payload jsonb,
        p_operation_id text,
        p_idempotency_key text,
        p_expected_prev_digest text,
        p_recorded_at timestamptz,
        p_recorded_by text
      ) RETURNS TABLE(event_id uuid, event_sequence bigint, event_digest text)
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = ${schema}, pg_catalog
      AS $function$
      DECLARE
        existing ${journal}%ROWTYPE;
        prior_sequence bigint;
        prior_digest text;
        prior_event_kind text;
        prior_payload jsonb;
        prior_policy_kind text;
        prior_policy_payload jsonb;
        next_sequence bigint;
        payload_canonical text;
        next_digest text;
        next_event_id uuid;
        previous_gate text;
        aggregate_feed numeric;
        aggregate_growth numeric;
        tenant_context uuid;
        journal_rls_enabled boolean;
      BEGIN
        tenant_context := NULLIF(
          current_setting(${sqlLiteral(tenantIsolation.contextGuc)}, true), ''
        )::uuid;
        SELECT relation.relrowsecurity
          INTO journal_rls_enabled
          FROM pg_class relation
         WHERE relation.oid = ${sqlLiteral(AUTHORITY.journal.relation)}::regclass;
        IF journal_rls_enabled AND tenant_context IS DISTINCT FROM p_tenant_id THEN
          RAISE EXCEPTION USING
            ERRCODE = '42501',
            MESSAGE = 'feeding provenance tenant does not match app.current_tenant';
        END IF;
        IF p_tenant_id IS NULL OR p_subject_id IS NULL OR p_recorded_at IS NULL
           OR p_operation_id IS NULL OR p_operation_id = '' OR p_operation_id <> btrim(p_operation_id)
           OR length(p_operation_id) > 200
           OR p_idempotency_key IS NULL OR p_idempotency_key = ''
           OR p_idempotency_key <> btrim(p_idempotency_key) OR length(p_idempotency_key) > 240
           OR p_recorded_by IS NULL OR p_recorded_by = '' OR p_recorded_by <> btrim(p_recorded_by)
           OR length(p_recorded_by) > 200
           OR p_expected_prev_digest !~ '^[0-9a-f]{64}$' THEN
          RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid feeding provenance append envelope';
        END IF;
        IF NOT ${payloadValidator}(p_subject_kind, p_event_kind, p_payload) THEN
          RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid feeding provenance payload';
        END IF;
        payload_canonical := ${canonicalFunction}(p_payload);
        IF p_subject_kind = 'FEEDING_RECORD' AND NOT EXISTS (
          SELECT 1 FROM feeding_records
           WHERE id = p_subject_id AND "tenantId" = p_tenant_id
        ) THEN
          RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'feeding provenance record subject does not exist';
        ELSIF p_subject_kind = 'DAY_PLAN' AND NOT EXISTS (
          SELECT 1 FROM feeding_day_plans
           WHERE id = p_subject_id AND "tenantId" = p_tenant_id
        ) THEN
          RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'feeding provenance day-plan subject does not exist';
        END IF;

        PERFORM pg_advisory_xact_lock(
          hashtextextended(
            p_tenant_id::text || ':idempotency:' || p_idempotency_key,
            0
          )
        );
        PERFORM pg_advisory_xact_lock(
          hashtextextended(p_tenant_id::text || ':' || p_subject_kind || ':' || p_subject_id::text, 0)
        );
        SELECT * INTO existing
          FROM ${journal}
         WHERE "tenantId" = p_tenant_id AND "idempotencyKey" = p_idempotency_key;
        IF FOUND THEN
          IF existing."subjectKind" <> p_subject_kind
             OR existing."subjectId" <> p_subject_id
             OR existing."eventKind" <> p_event_kind
             OR existing."payloadCanonical" <> payload_canonical
             OR existing."operationId" <> p_operation_id
             OR existing."prevDigest" <> p_expected_prev_digest
             OR existing."recordedAt" <> p_recorded_at
             OR existing."recordedBy" <> p_recorded_by THEN
            RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'feeding provenance idempotency conflict';
          END IF;
          RETURN QUERY SELECT existing."eventId", existing.sequence, existing."eventDigest"::text;
          RETURN;
        END IF;

        SELECT e.sequence, e."eventDigest", e."eventKind", e.payload
          INTO prior_sequence, prior_digest, prior_event_kind, prior_payload
          FROM ${journal} e
         WHERE e."tenantId" = p_tenant_id
           AND e."subjectKind" = p_subject_kind
           AND e."subjectId" = p_subject_id
         ORDER BY e.sequence DESC
         LIMIT 1;
        prior_digest := COALESCE(prior_digest, ${sqlLiteral(ROOT_DIGEST)});
        prior_sequence := COALESCE(prior_sequence, 0);
        IF prior_digest <> p_expected_prev_digest THEN
          RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'stale feeding provenance predecessor';
        END IF;

        IF NOT (
          ${legalTransitionPredicate()}
        ) THEN
          RAISE EXCEPTION USING
            ERRCODE = '55000',
            MESSAGE = 'illegal feeding provenance predecessor transition';
        END IF;
        IF ${predecessorDigestMismatchPredicate()} THEN
          RAISE EXCEPTION USING
            ERRCODE = '40001',
            MESSAGE = 'feeding provenance payload predecessor digest mismatch';
        END IF;
        IF ${continuityMismatchPredicate()} THEN
          RAISE EXCEPTION USING
            ERRCODE = '55000',
            MESSAGE = 'feeding provenance immutable payload continuity mismatch';
        END IF;

        IF p_subject_kind = 'DAY_PLAN' THEN
          SELECT e."eventKind", e.payload
            INTO prior_policy_kind, prior_policy_payload
            FROM ${journal} e
           WHERE e."tenantId" = p_tenant_id
             AND e."subjectKind" = 'DAY_PLAN'
             AND e."subjectId" = p_subject_id
             AND e."eventKind" IN (
               'GROWTH_POLICY_ASSERTED', 'GROWTH_POLICY_QUARANTINED', 'GROWTH_POLICY_RESOLVED'
             )
           ORDER BY e.sequence DESC LIMIT 1;
          IF p_event_kind = 'GROWTH_APPLIED' THEN
            IF prior_policy_kind NOT IN ('GROWTH_POLICY_ASSERTED', 'GROWTH_POLICY_RESOLVED') THEN
              RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'growth cannot apply without qualified policy';
            END IF;
            IF p_payload->>'expectedFcr' <> prior_policy_payload->>'expectedFcr' THEN
              RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'growth FCR differs from frozen policy';
            END IF;
            SELECT COALESCE(SUM((e.payload->>'feedDeltaKg')::numeric), 0),
                   COALESCE(SUM((e.payload->>'growthDeltaKg')::numeric), 0)
              INTO aggregate_feed, aggregate_growth
              FROM ${journal} e
             WHERE e."tenantId" = p_tenant_id
               AND e."subjectKind" = 'DAY_PLAN'
               AND e."subjectId" = p_subject_id
               AND e."eventKind" = 'GROWTH_APPLIED';
            IF aggregate_feed + (p_payload->>'feedDeltaKg')::numeric < 0
               OR aggregate_growth + (p_payload->>'growthDeltaKg')::numeric < 0 THEN
              RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'growth correction exceeds applied provenance';
            END IF;
          END IF;
        END IF;

        next_sequence := prior_sequence + 1;
        next_digest := ${digestFunction}(
          p_tenant_id, p_subject_kind, p_subject_id, next_sequence, prior_digest,
          p_event_kind, payload_canonical, p_operation_id, p_idempotency_key,
          p_recorded_at, p_recorded_by
        );
        next_event_id := gen_random_uuid();
        previous_gate := current_setting('aqua.feeding_historical_append_digest', true);
        PERFORM set_config(
          'aqua.feeding_historical_append_digest',
          ${sqlLiteral(PROVENANCE_CATALOG_DIGEST)},
          true
        );
        BEGIN
          INSERT INTO ${journal} (
            "eventId", "tenantId", "subjectKind", "subjectId", sequence, "prevDigest",
            "eventKind", payload, "payloadCanonical", "operationId", "idempotencyKey",
            "recordedAt", "recordedBy", "schemaVersion", "catalogDigest", "eventDigest"
          ) VALUES (
            next_event_id, p_tenant_id, p_subject_kind, p_subject_id, next_sequence,
            prior_digest, p_event_kind, p_payload, payload_canonical, p_operation_id,
            p_idempotency_key, p_recorded_at, p_recorded_by,
            ${sqlLiteral(AUTHORITY.schemaVersion)}, ${sqlLiteral(PROVENANCE_CATALOG_DIGEST)}, next_digest
          );
        EXCEPTION WHEN OTHERS THEN
          PERFORM set_config(
            'aqua.feeding_historical_append_digest', COALESCE(previous_gate, ''), true
          );
          RAISE;
        END;
        PERFORM set_config(
          'aqua.feeding_historical_append_digest', COALESCE(previous_gate, ''), true
        );
        IF p_event_kind IN ('GROWTH_POLICY_ASSERTED', 'GROWTH_POLICY_RESOLVED') THEN
          UPDATE feeding_day_plans
             SET "growthPolicyVersion" = (p_payload->>'policyVersion')::smallint,
                 "growthApplicationMode" = p_payload->>'growthApplicationMode'
           WHERE id = p_subject_id AND "tenantId" = p_tenant_id;
        ELSIF p_event_kind = 'GROWTH_POLICY_QUARANTINED' THEN
          UPDATE feeding_day_plans
             SET "growthPolicyVersion" = NULL,
                 "growthApplicationMode" = NULL,
                 "rollupAppliedKg" = 0,
                 "rollupGrowthKg" = 0,
                 "rollupLastRunAt" = NULL
           WHERE id = p_subject_id AND "tenantId" = p_tenant_id;
        ELSIF p_event_kind = 'GROWTH_APPLIED'
              AND p_payload->>'applicationMode' = 'DAILY_ROLLUP' THEN
          UPDATE feeding_day_plans plan
             SET "rollupAppliedKg" = projection.feed,
                 "rollupGrowthKg" = projection.growth,
                 "rollupLastRunAt" = projection.applied_at,
                 "rollupAppliedAt" = COALESCE(plan."rollupAppliedAt", projection.applied_at)
            FROM (
              SELECT COALESCE(SUM((e.payload->>'feedDeltaKg')::numeric), 0) AS feed,
                     COALESCE(SUM((e.payload->>'growthDeltaKg')::numeric), 0) AS growth,
                     MAX(e."recordedAt") AS applied_at
                FROM ${journal} e
               WHERE e."tenantId" = p_tenant_id
                 AND e."subjectKind" = 'DAY_PLAN'
                 AND e."subjectId" = p_subject_id
                 AND e."eventKind" = 'GROWTH_APPLIED'
                 AND e.payload->>'applicationMode' = 'DAILY_ROLLUP'
            ) projection
           WHERE plan.id = p_subject_id AND plan."tenantId" = p_tenant_id;
        END IF;
        RETURN QUERY SELECT next_event_id, next_sequence, next_digest;
      END
      $function$
    `);

    await this.createProjections(queryRunner, qualified, journal);
    await this.createPourReconstructionFunction(queryRunner, qualified);
    await this.backfillRecordAttribution(queryRunner, qualified, appendFunction, journal);
    await this.backfillDayPlanGrowth(queryRunner, qualified, appendFunction, journal);
    await this.installProjectionGuards(queryRunner, qualified, journal);
    await this.installTenantIsolation(queryRunner, journal);

    await queryRunner.query(`
      ALTER TABLE "feeding_day_plans"
        DROP CONSTRAINT IF EXISTS "CHK_fdp_growth_policy_version_v1",
        DROP CONSTRAINT IF EXISTS "CHK_fdp_growth_application_mode",
        ADD CONSTRAINT "CHK_fdp_growth_policy_version_v1"
          CHECK ("growthPolicyVersion" IS NULL OR "growthPolicyVersion" = 1),
        ADD CONSTRAINT "CHK_fdp_growth_application_mode"
          CHECK (
            ("growthPolicyVersion" IS NULL AND "growthApplicationMode" IS NULL)
            OR ("growthPolicyVersion" = 1 AND "growthApplicationMode" IN ('daily', 'per_meal'))
          )
    `);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_fdp_rollup_pending"`);
    await queryRunner.query(`
      CREATE INDEX "IDX_fdp_rollup_pending"
        ON "feeding_day_plans" ("tenantId", "siteId", "planDate", "unitId")
        WHERE "growthApplicationMode" = 'daily'
          AND status IN ('in_progress', 'completed')
    `);

    await queryRunner.query(`REVOKE ALL ON ${journal} FROM PUBLIC`);
    await queryRunner.query(`REVOKE ALL ON FUNCTION ${appendFunction}(
      uuid, text, uuid, text, jsonb, text, text, text, timestamptz, text
    ) FROM PUBLIC`);
    await queryRunner.query(`
      DO $roles$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'farm_service') THEN
          GRANT EXECUTE ON FUNCTION ${appendFunction}(
            uuid, text, uuid, text, jsonb, text, text, text, timestamptz, text
          ) TO farm_service;
          GRANT SELECT ON ${journal} TO farm_service;
          GRANT SELECT ON
            ${qualified(AUTHORITY.projections.currentEvent)},
            ${qualified(AUTHORITY.projections.recordAttribution)},
            ${qualified(AUTHORITY.projections.qualifiedRecords)},
            ${qualified(AUTHORITY.projections.dayPlanGrowth)}
          TO farm_service;
        END IF;
      END
      $roles$
    `);
  }

  private async createProjections(
    queryRunner: QueryRunner,
    qualified: (name: string) => string,
    journal: string,
  ): Promise<void> {
    await queryRunner.query(`
      CREATE OR REPLACE VIEW ${qualified(AUTHORITY.projections.currentEvent)}
      WITH (security_barrier = true, security_invoker = true) AS
      SELECT DISTINCT ON (e."tenantId", e."subjectKind", e."subjectId")
             e."tenantId", e."subjectKind", e."subjectId", e.sequence,
             e."eventKind", e.payload, e."eventDigest", e."recordedAt"
        FROM ${journal} e
       ORDER BY e."tenantId", e."subjectKind", e."subjectId", e.sequence DESC
    `);
    await queryRunner.query(`
      CREATE OR REPLACE VIEW ${qualified(AUTHORITY.projections.recordAttribution)}
      WITH (security_barrier = true, security_invoker = true) AS
      SELECT e."tenantId", e."subjectId" AS "feedingRecordId", e.sequence,
             e."eventDigest", e."recordedAt",
             CASE WHEN e."eventKind" = 'ATTRIBUTION_QUARANTINED'
                  THEN 'QUARANTINED' ELSE 'QUALIFIED' END AS status,
             e.payload->>'reasonCode' AS "reasonCode",
             NULLIF(e.payload->>'batchId', '')::uuid AS "batchId",
             NULLIF(e.payload->>'batchLocationId', '')::uuid AS "batchLocationId",
             NULLIF(e.payload->>'equipmentId', '')::uuid AS "equipmentId",
             e.payload->>'locationType' AS "locationType",
             NULLIF(e.payload->>'sourceExecutionId', '')::uuid AS "sourceExecutionId",
             e.payload
        FROM ${qualified(AUTHORITY.projections.currentEvent)} e
       WHERE e."subjectKind" = 'FEEDING_RECORD'
    `);
    await queryRunner.query(`
      CREATE OR REPLACE VIEW ${qualified(AUTHORITY.projections.qualifiedRecords)}
      WITH (security_barrier = true, security_invoker = true) AS
      SELECT records.*
        FROM feeding_records records
        LEFT JOIN ${qualified(AUTHORITY.projections.recordAttribution)} attribution
          ON attribution."tenantId" = records."tenantId"
         AND attribution."feedingRecordId" = records.id
       WHERE records."sourceExecutionId" IS NULL OR attribution.status = 'QUALIFIED'
    `);
    await queryRunner.query(`
      CREATE OR REPLACE VIEW ${qualified(AUTHORITY.projections.dayPlanGrowth)}
      WITH (security_barrier = true, security_invoker = true) AS
      WITH policy AS (
        SELECT DISTINCT ON (e."tenantId", e."subjectId")
               e."tenantId", e."subjectId" AS "dayPlanId", e."eventKind",
               e."eventDigest", e.payload, e.sequence
          FROM ${journal} e
         WHERE e."subjectKind" = 'DAY_PLAN'
           AND e."eventKind" IN (
             'GROWTH_POLICY_ASSERTED', 'GROWTH_POLICY_QUARANTINED', 'GROWTH_POLICY_RESOLVED'
           )
         ORDER BY e."tenantId", e."subjectId", e.sequence DESC
      ), applied AS (
        SELECT e."tenantId", e."subjectId" AS "dayPlanId",
               COALESCE(SUM((e.payload->>'feedDeltaKg')::numeric), 0)::numeric(18,3)
                 AS "totalAppliedFeedKg",
               COALESCE(SUM((e.payload->>'growthDeltaKg')::numeric), 0)::numeric(18,3)
                 AS "totalAppliedGrowthKg",
               COALESCE(SUM((e.payload->>'feedDeltaKg')::numeric)
                 FILTER (WHERE e.payload->>'applicationMode' = 'DAILY_ROLLUP'), 0)::numeric(18,3)
                 AS "dailyAppliedFeedKg",
               COALESCE(SUM((e.payload->>'growthDeltaKg')::numeric)
                 FILTER (WHERE e.payload->>'applicationMode' = 'DAILY_ROLLUP'), 0)::numeric(18,3)
                 AS "dailyAppliedGrowthKg",
               MAX(e."recordedAt") AS "lastAppliedAt"
          FROM ${journal} e
         WHERE e."subjectKind" = 'DAY_PLAN' AND e."eventKind" = 'GROWTH_APPLIED'
         GROUP BY e."tenantId", e."subjectId"
      )
      SELECT plans."tenantId", plans.id AS "dayPlanId",
             CASE WHEN policy."eventKind" = 'GROWTH_POLICY_QUARANTINED'
                  THEN 'QUARANTINED' ELSE 'QUALIFIED' END AS status,
             policy."eventDigest" AS "policyEventDigest",
             policy.payload->>'reasonCode' AS "reasonCode",
             NULLIF(policy.payload->>'policyVersion', '')::smallint AS "policyVersion",
             policy.payload->>'growthApplicationMode' AS "growthApplicationMode",
             NULLIF(policy.payload->>'expectedFcr', '')::numeric AS "expectedFcr",
             CASE WHEN policy."eventKind" = 'GROWTH_POLICY_QUARANTINED' THEN NULL
                  ELSE COALESCE(applied."totalAppliedFeedKg", 0) END AS "totalAppliedFeedKg",
             CASE WHEN policy."eventKind" = 'GROWTH_POLICY_QUARANTINED' THEN NULL
                  ELSE COALESCE(applied."totalAppliedGrowthKg", 0) END AS "totalAppliedGrowthKg",
             CASE WHEN policy."eventKind" = 'GROWTH_POLICY_QUARANTINED' THEN NULL
                  ELSE COALESCE(applied."dailyAppliedFeedKg", 0) END AS "dailyAppliedFeedKg",
             CASE WHEN policy."eventKind" = 'GROWTH_POLICY_QUARANTINED' THEN NULL
                  ELSE COALESCE(applied."dailyAppliedGrowthKg", 0) END AS "dailyAppliedGrowthKg",
             applied."lastAppliedAt"
        FROM feeding_day_plans plans
        LEFT JOIN policy
          ON policy."tenantId" = plans."tenantId" AND policy."dayPlanId" = plans.id
        LEFT JOIN applied
          ON applied."tenantId" = plans."tenantId" AND applied."dayPlanId" = plans.id
    `);
  }

  private async createPourReconstructionFunction(
    queryRunner: QueryRunner,
    qualified: (name: string) => string,
  ): Promise<void> {
    const functionName = qualified('reconstruct_feeding_meal_at_v1');
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION ${functionName}(
        p_pours jsonb,
        p_actual_kg numeric,
        p_cut timestamptz
      ) RETURNS jsonb
      LANGUAGE plpgsql
      IMMUTABLE STRICT
      SET search_path = pg_catalog
      AS $function$
      DECLARE
        entry jsonb;
        entry_index integer := 0;
        pour_index integer;
        current_kg numeric;
        original_kg numeric;
        poured_at timestamptz;
        corrected_at timestamptz;
        correction_count integer;
        current_total numeric := 0;
        cut_total numeric := 0;
      BEGIN
        IF jsonb_typeof(p_pours) <> 'array' THEN
          RETURN jsonb_build_object('valid', 'false', 'reason', 'MALFORMED_POUR_LEDGER');
        END IF;
        FOR entry IN SELECT value FROM jsonb_array_elements(p_pours) LOOP
          IF jsonb_typeof(entry) <> 'object'
             OR jsonb_typeof(entry->'pourIndex') <> 'number'
             OR jsonb_typeof(entry->'kg') <> 'number'
             OR jsonb_typeof(entry->'at') <> 'string' THEN
            RETURN jsonb_build_object('valid', 'false', 'reason', 'MALFORMED_POUR_LEDGER');
          END IF;
          BEGIN
            pour_index := (entry->>'pourIndex')::integer;
            current_kg := (entry->>'kg')::numeric;
            poured_at := (entry->>'at')::timestamptz;
            correction_count := COALESCE((entry->>'corrections')::integer, 0);
            corrected_at := CASE WHEN entry ? 'correctedAt'
                                 THEN (entry->>'correctedAt')::timestamptz END;
            original_kg := CASE WHEN entry ? 'originalKg'
                                THEN (entry->>'originalKg')::numeric END;
          EXCEPTION WHEN OTHERS THEN
            RETURN jsonb_build_object('valid', 'false', 'reason', 'MALFORMED_POUR_LEDGER');
          END;
          IF pour_index <> entry_index OR current_kg <= 0 OR correction_count < 0 THEN
            RETURN jsonb_build_object('valid', 'false', 'reason', 'MALFORMED_POUR_LEDGER');
          END IF;
          current_total := current_total + current_kg;
          IF poured_at <= p_cut THEN
            IF corrected_at IS NULL OR corrected_at <= p_cut THEN
              cut_total := cut_total + current_kg;
            ELSIF correction_count = 1 AND original_kg > 0 THEN
              cut_total := cut_total + original_kg;
            ELSIF correction_count > 1 THEN
              RETURN jsonb_build_object(
                'valid', 'false', 'reason', 'MULTIPLE_POST_STAMP_CORRECTIONS'
              );
            ELSE
              RETURN jsonb_build_object('valid', 'false', 'reason', 'MALFORMED_POUR_LEDGER');
            END IF;
          END IF;
          entry_index := entry_index + 1;
        END LOOP;
        IF round(current_total, 3) <> round(p_actual_kg, 3) THEN
          RETURN jsonb_build_object('valid', 'false', 'reason', 'POUR_ACTUAL_MISMATCH');
        END IF;
        RETURN jsonb_build_object(
          'valid', 'true', 'reason', NULL, 'cutKg', to_char(round(cut_total, 3), 'FM999999999990.000')
        );
      END
      $function$
    `);
  }

  private async backfillRecordAttribution(
    queryRunner: QueryRunner,
    qualified: (name: string) => string,
    appendFunction: string,
    journal: string,
  ): Promise<void> {
    const canonical = qualified('canonical_feeding_historical_json_v1');
    await queryRunner.query(`DROP TABLE IF EXISTS pg_temp.feeding_attribution_classification_v1`);
    await queryRunner.query(`
      CREATE TEMP TABLE feeding_attribution_classification_v1 ON COMMIT DROP AS
      WITH candidates AS (
        SELECT records.id AS "recordId",
               COUNT(locations.id)::integer AS "candidateCount",
               (array_agg(locations.id ORDER BY locations.id)
                 FILTER (WHERE locations.id IS NOT NULL))[1] AS "targetLocationId",
               (array_agg(locations."batchId" ORDER BY locations.id)
                 FILTER (WHERE locations.id IS NOT NULL))[1] AS "targetBatchId",
               ${canonical}(COALESCE(
                 jsonb_agg(jsonb_build_object(
                   'batchId', locations."batchId"::text,
                   'batchLocationId', locations.id::text,
                   'exitedAt', CASE WHEN locations."exitedAt" IS NULL THEN NULL
                                    ELSE to_char(locations."exitedAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END,
                   'movedAt', to_char(locations."movedAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
                 ) ORDER BY locations.id) FILTER (WHERE locations.id IS NOT NULL),
                 '[]'::jsonb
               )) AS "candidateSnapshot"
          FROM feeding_records records
          LEFT JOIN daily_feeding_executions executions
            ON executions.id = records."sourceExecutionId"
           AND executions."tenantId" = records."tenantId"
          LEFT JOIN batch_locations locations
            ON locations."tenantId" = records."tenantId"
           AND executions."completedAt" IS NOT NULL
           AND locations."movedAt" <= executions."completedAt"
           AND (locations."exitedAt" IS NULL OR executions."completedAt" < locations."exitedAt")
           AND (
             (executions."equipmentType"::text = 'tank' AND locations."tankId" = executions."equipmentId")
             OR (executions."equipmentType"::text = 'pond' AND locations."pondId" = executions."equipmentId")
           )
         WHERE records."sourceExecutionId" IS NOT NULL
         GROUP BY records.id
      )
      SELECT records.id AS "recordId", records."tenantId", records."sourceExecutionId",
             records."batchId" AS "originalBatchId", records."batchLocationId" AS "originalLocationId",
             executions."completedAt", executions."equipmentId",
             executions."equipmentType"::text AS "equipmentType",
             candidates."targetBatchId", candidates."targetLocationId", candidates."candidateSnapshot",
             CASE
               WHEN executions.id IS NULL THEN 'MISSING_SOURCE_EXECUTION'
               WHEN executions."completedAt" IS NULL THEN 'NULL_COMPLETION_TIME'
               WHEN executions."equipmentType"::text NOT IN ('tank', 'pond')
                 THEN 'UNSUPPORTED_EQUIPMENT_TYPE'
               WHEN candidates."candidateCount" = 0 THEN 'MISSING_OCCUPANCY_INTERVAL'
               WHEN candidates."candidateCount" > 1 THEN 'OVERLAPPING_OCCUPANCY_INTERVALS'
               ELSE NULL
             END AS "reasonCode",
             COALESCE(executions."completedAt", records."createdAt", statement_timestamp())
               AS "recordedAt",
             ${canonical}(jsonb_build_object(
               'actualAmount', to_char(records."actualAmount"::numeric, 'FM999999999990.000'),
               'batchId', records."batchId"::text,
               'batchLocationId', records."batchLocationId"::text,
               'feedingDate', records."feedingDate"::text,
               'feedingRecordId', records.id::text,
               'feedingTime', records."feedingTime",
               'pondId', records."pondId"::text,
               'sourceExecutionId', records."sourceExecutionId"::text,
               'tankId', records."tankId"::text,
               'tenantId', records."tenantId"::text
             )) AS "originalSnapshot"
        FROM feeding_records records
        JOIN candidates ON candidates."recordId" = records.id
        LEFT JOIN daily_feeding_executions executions
          ON executions.id = records."sourceExecutionId"
         AND executions."tenantId" = records."tenantId"
       WHERE records."sourceExecutionId" IS NOT NULL
    `);
    await queryRunner.query(`
      ALTER TABLE feeding_attribution_classification_v1 ADD COLUMN "originalRecordDigest" text;
      UPDATE feeding_attribution_classification_v1
         SET "originalRecordDigest" = encode(
           pg_catalog.sha256(convert_to(
             ${canonical}(jsonb_build_object(
               'domain', 'aquaculture.feeding-historical-record-snapshot',
               'schemaVersion', ${sqlLiteral(AUTHORITY.schemaVersion)},
               'value', "originalSnapshot"
             )), 'UTF8'
           )), 'hex'
         )
    `);
    await queryRunner.query(`
      SELECT appended.event_id
        FROM feeding_attribution_classification_v1 classified
        CROSS JOIN LATERAL ${appendFunction}(
          classified."tenantId", 'FEEDING_RECORD', classified."recordId",
          CASE WHEN classified."reasonCode" IS NULL
               THEN 'ATTRIBUTION_ASSERTED' ELSE 'ATTRIBUTION_QUARANTINED' END,
          CASE WHEN classified."reasonCode" IS NULL THEN jsonb_build_object(
            'batchId', classified."targetBatchId"::text,
            'batchLocationId', classified."targetLocationId"::text,
            'completedAt', to_char(classified."completedAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
            'equipmentId', classified."equipmentId"::text,
            'locationType', classified."equipmentType",
            'originalRecordDigest', classified."originalRecordDigest",
            'schemaVersion', ${sqlLiteral(AUTHORITY.schemaVersion)},
            'sourceExecutionId', classified."sourceExecutionId"::text,
            'sourceKind', 'LEGACY_EXECUTION'
          ) ELSE jsonb_build_object(
            'candidateSnapshot', classified."candidateSnapshot",
            'observedAt', to_char(classified."recordedAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
            'originalRecordDigest', classified."originalRecordDigest",
            'originalSnapshot', classified."originalSnapshot",
            'reasonCode', classified."reasonCode",
            'schemaVersion', ${sqlLiteral(AUTHORITY.schemaVersion)},
            'sourceExecutionId', classified."sourceExecutionId"::text,
            'sourceKind', 'LEGACY_EXECUTION'
          ) END,
          'migration/180890',
          'migration-180890:attribution:' || classified."recordId"::text || ':v1',
          ${sqlLiteral(ROOT_DIGEST)}, classified."recordedAt", 'migration/180890'
        ) appended
       WHERE NOT EXISTS (
         SELECT 1 FROM ${journal} existing
          WHERE existing."tenantId" = classified."tenantId"
            AND existing."idempotencyKey" =
                'migration-180890:attribution:' || classified."recordId"::text || ':v1'
       )
       ORDER BY classified."recordId"
    `);

    const negative: Array<{ batchId: string; available: string; required: string }> =
      await queryRunner.query(`
        WITH required AS (
          SELECT classified."tenantId", classified."originalBatchId" AS "batchId",
                 SUM(records."actualAmount") AS feed,
                 SUM(COALESCE(records."feedCost", 0)) AS cost
            FROM feeding_attribution_classification_v1 classified
            JOIN feeding_records records ON records.id = classified."recordId"
           WHERE classified."reasonCode" IS NULL
             AND classified."originalBatchId" <> classified."targetBatchId"
           GROUP BY classified."tenantId", classified."originalBatchId"
        )
        SELECT batches.id::text AS "batchId", batches."totalFeedConsumed"::text AS available,
               required.feed::text AS required
          FROM required
          JOIN batches_v2 batches
            ON batches.id = required."batchId" AND batches."tenantId" = required."tenantId"
         WHERE COALESCE(batches."totalFeedConsumed", 0) < required.feed
            OR COALESCE(batches."totalFeedCost", 0) < required.cost
         LIMIT 1
      `);
    if (negative[0]) {
      throw new Error(
        `[feeding-historical-provenance] attribution delta would make batch ${negative[0].batchId} negative`,
      );
    }
    await queryRunner.query(`
      WITH deltas AS (
        SELECT "tenantId", "batchId", SUM(feed)::numeric AS feed, SUM(cost)::numeric AS cost
          FROM (
            SELECT classified."tenantId", classified."originalBatchId" AS "batchId",
                   -records."actualAmount"::numeric AS feed,
                   -COALESCE(records."feedCost", 0)::numeric AS cost
              FROM feeding_attribution_classification_v1 classified
              JOIN feeding_records records ON records.id = classified."recordId"
             WHERE classified."reasonCode" IS NULL
               AND classified."originalBatchId" <> classified."targetBatchId"
            UNION ALL
            SELECT classified."tenantId", classified."targetBatchId" AS "batchId",
                   records."actualAmount"::numeric AS feed,
                   COALESCE(records."feedCost", 0)::numeric AS cost
              FROM feeding_attribution_classification_v1 classified
              JOIN feeding_records records ON records.id = classified."recordId"
             WHERE classified."reasonCode" IS NULL
               AND classified."originalBatchId" <> classified."targetBatchId"
          ) movements
         GROUP BY "tenantId", "batchId"
      )
      UPDATE batches_v2 batches
         SET "totalFeedConsumed" = COALESCE(batches."totalFeedConsumed", 0) + deltas.feed,
             "totalFeedCost" = COALESCE(batches."totalFeedCost", 0) + deltas.cost
        FROM deltas
       WHERE batches.id = deltas."batchId" AND batches."tenantId" = deltas."tenantId"
    `);
    await queryRunner.query(`
      UPDATE feeding_records records
         SET "batchId" = classified."targetBatchId",
             "batchLocationId" = classified."targetLocationId",
             "tankId" = CASE WHEN classified."equipmentType" = 'tank'
                              THEN classified."equipmentId" ELSE NULL END,
             "pondId" = CASE WHEN classified."equipmentType" = 'pond'
                              THEN classified."equipmentId" ELSE NULL END
        FROM feeding_attribution_classification_v1 classified
       WHERE records.id = classified."recordId"
         AND records."tenantId" = classified."tenantId"
         AND classified."reasonCode" IS NULL
    `);
  }

  private async backfillDayPlanGrowth(
    queryRunner: QueryRunner,
    qualified: (name: string) => string,
    appendFunction: string,
    journal: string,
  ): Promise<void> {
    const canonical = qualified('canonical_feeding_historical_json_v1');
    const reconstruct = qualified('reconstruct_feeding_meal_at_v1');
    await queryRunner.query(`DROP TABLE IF EXISTS pg_temp.feeding_growth_classification_v1`);
    await queryRunner.query(`
      CREATE TEMP TABLE feeding_growth_classification_v1 ON COMMIT DROP AS
      WITH meal_proofs AS (
        SELECT plans."tenantId", plans.id AS "dayPlanId", meals.id AS "mealId",
               CASE WHEN meals.id IS NULL
                    THEN jsonb_build_object('valid', 'true', 'reason', NULL, 'cutKg', '0.000')
                    ELSE ${reconstruct}(meals.pours, meals."actualKg", plans."rollupAppliedAt")
               END AS proof
          FROM feeding_day_plans plans
          LEFT JOIN feeding_meals meals
            ON meals."tenantId" = plans."tenantId" AND meals."dayPlanId" = plans.id
         WHERE plans."rollupAppliedAt" IS NOT NULL
      ), summarized AS (
        SELECT "tenantId", "dayPlanId",
               bool_and((proof->>'valid')::boolean) AS valid,
               MIN(proof->>'reason') FILTER (WHERE proof->>'valid' = 'false') AS reason,
               SUM((proof->>'cutKg')::numeric) FILTER (WHERE proof->>'valid' = 'true')
                 AS "cutFeedKg"
          FROM meal_proofs GROUP BY "tenantId", "dayPlanId"
      )
      SELECT plans."tenantId", plans.id AS "dayPlanId", plans."protocolId",
             plans."rollupAppliedAt", COALESCE(plans."createdAt", plans."rollupAppliedAt", statement_timestamp())
               AS "recordedAt",
             CASE WHEN jsonb_typeof(plans.snapshot->'expectedFcr') = 'number'
                  THEN (plans.snapshot->>'expectedFcr')::numeric END AS "expectedFcr",
             COALESCE(summarized."cutFeedKg", 0)::numeric(18,3) AS "cutFeedKg",
             CASE
               WHEN plans."rollupAppliedAt" IS NULL THEN 'UNSTAMPED_HISTORICAL_PLAN'
               WHEN jsonb_typeof(plans.snapshot->'expectedFcr') <> 'number'
                 OR (plans.snapshot->>'expectedFcr')::numeric <= 0 THEN 'INVALID_EXPECTED_FCR'
               WHEN NOT COALESCE(summarized.valid, true) THEN summarized.reason
               ELSE NULL
             END AS "reasonCode",
             ${canonical}(jsonb_build_object(
               'dayPlanId', plans.id::text,
               'growthApplicationMode', plans."growthApplicationMode",
               'growthPolicyVersion', plans."growthPolicyVersion"::text,
               'planDate', plans."planDate"::text,
               'protocolId', plans."protocolId"::text,
               'rollupAppliedAt', CASE WHEN plans."rollupAppliedAt" IS NULL THEN NULL
                 ELSE to_char(plans."rollupAppliedAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END,
               'snapshot', ${canonical}(plans.snapshot),
               'tenantId', plans."tenantId"::text,
               'unitId', plans."unitId"::text
             )) AS "originalSnapshot"
        FROM feeding_day_plans plans
        LEFT JOIN summarized
          ON summarized."tenantId" = plans."tenantId" AND summarized."dayPlanId" = plans.id
    `);
    await queryRunner.query(`
      SELECT appended.event_id
        FROM feeding_growth_classification_v1 classified
        CROSS JOIN LATERAL ${appendFunction}(
          classified."tenantId", 'DAY_PLAN', classified."dayPlanId",
          CASE WHEN classified."reasonCode" IS NULL
               THEN 'GROWTH_POLICY_ASSERTED' ELSE 'GROWTH_POLICY_QUARANTINED' END,
          CASE WHEN classified."reasonCode" IS NULL THEN jsonb_build_object(
            'expectedFcr', to_char(classified."expectedFcr", 'FM999999999990.000000'),
            'growthApplicationMode', 'daily',
            'policyVersion', '1',
            'proofAt', to_char(classified."rollupAppliedAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
            'proofKind', 'LEGACY_ROLLUP_STAMP',
            'resolutionNote', NULL,
            'resolvesEventDigest', NULL,
            'schemaVersion', ${sqlLiteral(AUTHORITY.schemaVersion)}
          ) ELSE jsonb_build_object(
            'observedAt', to_char(classified."recordedAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
            'originalSnapshot', classified."originalSnapshot",
            'protocolId', classified."protocolId"::text,
            'reasonCode', classified."reasonCode",
            'rollupAppliedAt', CASE WHEN classified."rollupAppliedAt" IS NULL THEN NULL
              ELSE to_char(classified."rollupAppliedAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END,
            'schemaVersion', ${sqlLiteral(AUTHORITY.schemaVersion)}
          ) END,
          'migration/180890',
          'migration-180890:growth-policy:' || classified."dayPlanId"::text || ':v1',
          ${sqlLiteral(ROOT_DIGEST)}, classified."recordedAt", 'migration/180890'
        ) appended
       WHERE NOT EXISTS (
         SELECT 1 FROM ${journal} existing
          WHERE existing."tenantId" = classified."tenantId"
            AND existing."idempotencyKey" =
                'migration-180890:growth-policy:' || classified."dayPlanId"::text || ':v1'
       )
       ORDER BY classified."dayPlanId"
    `);
    await queryRunner.query(`
      SELECT appended.event_id
        FROM feeding_growth_classification_v1 classified
        JOIN LATERAL (
          SELECT existing."eventDigest"
            FROM ${journal} existing
           WHERE existing."tenantId" = classified."tenantId"
             AND existing."subjectKind" = 'DAY_PLAN'
             AND existing."subjectId" = classified."dayPlanId"
           ORDER BY existing.sequence DESC LIMIT 1
        ) predecessor ON true
        CROSS JOIN LATERAL ${appendFunction}(
          classified."tenantId", 'DAY_PLAN', classified."dayPlanId", 'GROWTH_APPLIED',
          jsonb_build_object(
            'applicationMode', 'DAILY_ROLLUP',
            'appliedAt', to_char(classified."rollupAppliedAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
            'expectedFcr', to_char(classified."expectedFcr", 'FM999999999990.000000'),
            'feedDeltaKg', to_char(classified."cutFeedKg", 'FM999999999990.000'),
            'growthDeltaKg', to_char(round(classified."cutFeedKg" / classified."expectedFcr", 3), 'FM999999999990.000'),
            'schemaVersion', ${sqlLiteral(AUTHORITY.schemaVersion)},
            'sourceRef', 'legacy-rollup-stamp:' || classified."dayPlanId"::text
          ),
          'migration/180890',
          'migration-180890:growth-applied:' || classified."dayPlanId"::text || ':v1',
          predecessor."eventDigest", classified."rollupAppliedAt", 'migration/180890'
        ) appended
       WHERE classified."reasonCode" IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM ${journal} existing
            WHERE existing."tenantId" = classified."tenantId"
              AND existing."idempotencyKey" =
                  'migration-180890:growth-applied:' || classified."dayPlanId"::text || ':v1'
         )
       ORDER BY classified."dayPlanId"
    `);
  }

  private async installProjectionGuards(
    queryRunner: QueryRunner,
    qualified: (name: string) => string,
    journal: string,
  ): Promise<void> {
    const attribution = qualified(AUTHORITY.projections.recordAttribution);
    const growth = qualified(AUTHORITY.projections.dayPlanGrowth);
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION ${qualified('assert_feeding_record_attribution_projection_v1')}()
      RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $function$
      DECLARE projected record;
      BEGIN
        IF NEW."sourceExecutionId" IS NULL THEN RETURN NEW; END IF;
        SELECT * INTO projected FROM ${attribution}
         WHERE "tenantId" = NEW."tenantId" AND "feedingRecordId" = NEW.id;
        IF projected.status <> 'QUALIFIED'
           OR projected."sourceExecutionId" <> NEW."sourceExecutionId"
           OR projected."batchId" <> NEW."batchId"
           OR projected."batchLocationId" <> NEW."batchLocationId"
           OR (projected."locationType" = 'tank' AND projected."equipmentId" <> NEW."tankId")
           OR (projected."locationType" = 'pond' AND projected."equipmentId" <> NEW."pondId") THEN
          RAISE EXCEPTION USING ERRCODE = '55000',
            MESSAGE = 'feeding record attribution differs from append-only provenance';
        END IF;
        RETURN NEW;
      END
      $function$;
      CREATE OR REPLACE FUNCTION ${qualified('reject_historical_feeding_record_delete_v1')}()
      RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $function$
      BEGIN
        IF OLD."sourceExecutionId" IS NOT NULL THEN
          RAISE EXCEPTION USING ERRCODE = '55000',
            MESSAGE = 'historical feeding record deletion is forbidden by provenance authority';
        END IF;
        RETURN OLD;
      END
      $function$
    `);
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS "TRG_feeding_record_attribution_projection" ON feeding_records;
      CREATE CONSTRAINT TRIGGER "TRG_feeding_record_attribution_projection"
      AFTER INSERT OR UPDATE OF "sourceExecutionId", "batchId", "batchLocationId", "tankId", "pondId"
      ON feeding_records DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION ${qualified('assert_feeding_record_attribution_projection_v1')}();
      DROP TRIGGER IF EXISTS "TRG_historical_feeding_record_no_delete" ON feeding_records;
      CREATE TRIGGER "TRG_historical_feeding_record_no_delete"
      BEFORE DELETE ON feeding_records
      FOR EACH ROW EXECUTE FUNCTION ${qualified('reject_historical_feeding_record_delete_v1')}()
    `);
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION ${qualified('assert_day_plan_growth_projection_v1')}()
      RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $function$
      DECLARE projected record;
      BEGIN
        SELECT * INTO projected FROM ${growth}
         WHERE "tenantId" = NEW."tenantId" AND "dayPlanId" = NEW.id;
        IF projected.status IS NULL
           OR (projected.status = 'QUARANTINED' AND (
             NEW."growthPolicyVersion" IS NOT NULL OR NEW."growthApplicationMode" IS NOT NULL
           ))
           OR (projected.status = 'QUALIFIED' AND (
             NEW."growthPolicyVersion" IS DISTINCT FROM projected."policyVersion"
             OR NEW."growthApplicationMode" IS DISTINCT FROM projected."growthApplicationMode"
             OR (
               projected."growthApplicationMode" = 'daily'
               AND (
                 NEW."rollupAppliedKg" IS DISTINCT FROM projected."dailyAppliedFeedKg"
                 OR NEW."rollupGrowthKg" IS DISTINCT FROM projected."dailyAppliedGrowthKg"
               )
             )
           )) THEN
          RAISE EXCEPTION USING ERRCODE = '55000',
            MESSAGE = 'day-plan growth projection differs from append-only provenance';
        END IF;
        RETURN NEW;
      END
      $function$
    `);
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS "TRG_day_plan_growth_projection" ON feeding_day_plans;
      CREATE CONSTRAINT TRIGGER "TRG_day_plan_growth_projection"
      AFTER INSERT OR UPDATE OF "growthPolicyVersion", "growthApplicationMode",
        "rollupAppliedKg", "rollupGrowthKg", "rollupLastRunAt"
      ON feeding_day_plans DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION ${qualified('assert_day_plan_growth_projection_v1')}()
    `);

    // Post-create integrity pass: the journal itself is never trusted merely
    // because it was written by the function; chain and payload are re-derived.
    const invalid: Array<{ count: string }> = await queryRunner.query(`
      WITH chain AS (
        SELECT e.*,
               COALESCE(
                 lag(e."eventDigest") OVER (
                   PARTITION BY e."tenantId", e."subjectKind", e."subjectId" ORDER BY e.sequence
                 ),
                 ${sqlLiteral(ROOT_DIGEST)}
               ) AS expected_prev
          FROM ${journal} e
      )
      SELECT COUNT(*)::text AS count
        FROM chain
       WHERE "prevDigest" <> expected_prev
          OR "payloadCanonical" <> ${qualified('canonical_feeding_historical_json_v1')}(payload)
          OR "eventDigest" <> ${qualified(AUTHORITY.journal.digestFunction)}(
            "tenantId", "subjectKind", "subjectId", sequence, "prevDigest", "eventKind",
            "payloadCanonical", "operationId", "idempotencyKey", "recordedAt", "recordedBy"
          )
          OR NOT ${qualified('is_valid_feeding_historical_payload_v1')}(
            "subjectKind", "eventKind", payload
          )
    `);
    if (Number(invalid[0]?.count ?? '0') !== 0) {
      throw new Error('[feeding-historical-provenance] post-create journal integrity failed');
    }
  }

  private async installTenantIsolation(queryRunner: QueryRunner, journal: string): Promise<void> {
    const isolation = AUTHORITY.journal.tenantIsolation;
    const policy = quoteIdentifier(isolation.policyName);
    const tenantPredicate = `"tenantId" = NULLIF(
      pg_catalog.current_setting(${sqlLiteral(isolation.contextGuc)}, true), ''
    )::uuid`;
    await queryRunner.query(`
      ALTER TABLE ${journal} ENABLE ROW LEVEL SECURITY;
      ALTER TABLE ${journal} FORCE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS ${policy} ON ${journal};
      CREATE POLICY ${policy} ON ${journal}
        FOR ALL
        USING (${tenantPredicate})
        WITH CHECK (${tenantPredicate})
    `);
  }

  public async postCondition(queryRunner: QueryRunner): Promise<boolean> {
    const rows: Array<{ ok: boolean }> = await queryRunner.query(`
      SELECT
        to_regclass('feeding_day_plans') IS NULL
        OR (
          to_regclass(${sqlLiteral(AUTHORITY.journal.relation)}) IS NOT NULL
          AND to_regclass(${sqlLiteral(AUTHORITY.projections.recordAttribution)}) IS NOT NULL
          AND to_regclass(${sqlLiteral(AUTHORITY.projections.dayPlanGrowth)}) IS NOT NULL
          AND to_regprocedure(${sqlLiteral(
            `${AUTHORITY.journal.appendFunction}(uuid,text,uuid,text,jsonb,text,text,text,timestamp with time zone,text)`,
          )}) IS NOT NULL
          AND to_regprocedure(${sqlLiteral(
            `${AUTHORITY.journal.digestFunction}(uuid,text,uuid,bigint,text,text,text,text,text,timestamp with time zone,text)`,
          )}) IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM pg_trigger
             WHERE tgname = 'TRG_feeding_historical_journal_immutable' AND NOT tgisinternal
          )
          AND EXISTS (
            SELECT 1 FROM pg_trigger
             WHERE tgname = 'TRG_historical_feeding_record_no_delete' AND NOT tgisinternal
          )
          AND EXISTS (
            SELECT 1 FROM pg_trigger
             WHERE tgname = 'TRG_day_plan_growth_projection' AND NOT tgisinternal
          )
          AND EXISTS (
            SELECT 1
              FROM pg_class relation
             WHERE relation.oid = to_regclass(${sqlLiteral(AUTHORITY.journal.relation)})
               AND relation.relrowsecurity
               AND relation.relforcerowsecurity
          )
          AND EXISTS (
            SELECT 1
              FROM pg_policy policy
             WHERE policy.polrelid = to_regclass(${sqlLiteral(AUTHORITY.journal.relation)})
               AND policy.polname = ${sqlLiteral(AUTHORITY.journal.tenantIsolation.policyName)}
          )
        ) AS ok
    `);
    return rows[0]?.ok === true;
  }

  public async down(): Promise<void> {
    // Forward-only. The journal protects facts created by the shipped 180660
    // migration as well as later runtime writes; removing it would make those
    // histories indistinguishable again.
  }
}
