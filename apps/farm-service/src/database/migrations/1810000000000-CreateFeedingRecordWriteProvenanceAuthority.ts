import type { MigrationInterface, QueryRunner } from 'typeorm';

import {
  FEEDING_RECORD_WRITE_PROVENANCE_MIGRATION_SNAPSHOT_DIGEST_V1,
  FEEDING_RECORD_WRITE_PROVENANCE_MIGRATION_SNAPSHOT_V1,
} from './feeding-record-write-provenance-authority.v1';

const CATALOG_DIGEST =
  'f27e6565e9d797a8f822b6aec937ebec2b96a286f48ca9df1a8db9e6f95c9b5f';
const ROOT_DIGEST = '0'.repeat(64);
const AUTHORITY = FEEDING_RECORD_WRITE_PROVENANCE_MIGRATION_SNAPSHOT_V1;

if (FEEDING_RECORD_WRITE_PROVENANCE_MIGRATION_SNAPSHOT_DIGEST_V1 !== CATALOG_DIGEST) {
  throw new Error('Feeding-record write provenance migration snapshot digest mismatch');
}

function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function identifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

interface DatabaseIdentity {
  readonly schema: string;
  readonly owner: string;
}

/**
 * Establishes a forward-only write-origin authority for feeding records.
 * Historical rows are never guessed to be 180660 output: they are journaled
 * as AMBIGUOUS_PRE_AUTHORITY. A deletion of a sourceExecutionId row is legal
 * only inside the exact BACKFILL_180660 rollback protocol created here.
 */
export class CreateFeedingRecordWriteProvenanceAuthority1810000000000
  implements MigrationInterface
{
  name = 'CreateFeedingRecordWriteProvenanceAuthority1810000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '600s'`);
    const presence: Array<{ records: string | null; batches: string | null }> =
      await queryRunner.query(`
        SELECT to_regclass('feeding_records')::text AS records,
               to_regclass('batches_v2')::text AS batches
      `);
    if (!presence[0]?.records) return;
    if (!presence[0]?.batches) {
      throw new Error('[feeding-record-write-provenance] batches_v2 relation is required');
    }

    const identityRows: DatabaseIdentity[] = await queryRunner.query(`
      SELECT current_schema() AS schema, current_user AS owner
    `);
    const identity = identityRows[0];
    if (!identity?.schema || !identity.owner) {
      throw new Error('[feeding-record-write-provenance] cannot resolve tenant schema owner');
    }
    const schema = identifier(identity.schema);
    const qualified = (name: string): string => `${schema}.${identifier(name)}`;
    const records = qualified('feeding_records');
    const batches = qualified('batches_v2');
    const provenance = qualified(AUTHORITY.relation);
    const rollbackJournal = qualified(AUTHORITY.rollback.relation);
    const recordDigestFunction = qualified(AUTHORITY.recordDigestFunction);
    const provenanceDigestFunction = qualified('feeding_record_write_provenance_digest_v1');
    const rollbackDigestFunction = qualified('feeding_record_rollback_event_digest_v1');
    const internalAppendFunction = qualified(AUTHORITY.internalAppendFunction);
    const runtimeAppendFunction = qualified(AUTHORITY.appendFunction);
    const backfillRegistrationFunction = qualified(AUTHORITY.backfillRegistrationFunction);
    const rollbackFunction = qualified(AUTHORITY.rollback.function);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS ${provenance} (
        "feedingRecordId" uuid PRIMARY KEY,
        "tenantId" uuid NOT NULL,
        "writerAuthority" varchar(96) NOT NULL,
        "operationId" varchar(160) NOT NULL,
        origin varchar(32) NOT NULL,
        "sourceExecutionId" uuid,
        "recordDigest" char(64) NOT NULL,
        "catalogRevision" varchar(64) NOT NULL,
        "catalogDigest" char(64) NOT NULL,
        "provenanceDigest" char(64) NOT NULL UNIQUE,
        "recordedAt" timestamptz NOT NULL,
        CONSTRAINT "UQ_frwp_tenant_record" UNIQUE ("tenantId", "feedingRecordId"),
        CONSTRAINT "CHK_frwp_origin" CHECK (
          origin IN ('BACKFILL_180660', 'LIVE_DRAIN', 'RUNTIME_OPERATION',
                     'AMBIGUOUS_PRE_AUTHORITY')
        ),
        CONSTRAINT "CHK_frwp_catalog" CHECK (
          "catalogRevision" = ${literal(AUTHORITY.schemaVersion)}
          AND "catalogDigest" = ${literal(CATALOG_DIGEST)}
        ),
        CONSTRAINT "CHK_frwp_digest_shape" CHECK (
          "recordDigest" ~ '^[0-9a-f]{64}$'
          AND "catalogDigest" ~ '^[0-9a-f]{64}$'
          AND "provenanceDigest" ~ '^[0-9a-f]{64}$'
        ),
        CONSTRAINT "CHK_frwp_operation_identity" CHECK (
          length("operationId") BETWEEN 1 AND 160 AND btrim("operationId") = "operationId"
        ),
        CONSTRAINT "CHK_frwp_writer_origin" CHECK (
          (origin = 'BACKFILL_180660'
            AND "writerAuthority" = ${literal(AUTHORITY.writerAuthorities.backfill180660)}
            AND "sourceExecutionId" IS NOT NULL)
          OR (origin IN ('LIVE_DRAIN', 'RUNTIME_OPERATION')
            AND "writerAuthority" = ${literal(AUTHORITY.writerAuthorities.runtime)}
            AND (origin <> 'LIVE_DRAIN' OR "sourceExecutionId" IS NOT NULL))
          OR (origin = 'AMBIGUOUS_PRE_AUTHORITY'
            AND "writerAuthority" = ${literal(AUTHORITY.writerAuthorities.legacyQuarantine)})
        )
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_frwp_tenant_operation"
        ON ${provenance} ("tenantId", "operationId", "feedingRecordId")
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS ${rollbackJournal} (
        "eventId" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId" uuid NOT NULL,
        "rollbackOperationId" varchar(160) NOT NULL,
        "backfillOperationId" varchar(160) NOT NULL,
        phase varchar(12) NOT NULL,
        "targetSetDigest" char(64) NOT NULL,
        "recordCount" integer NOT NULL,
        "targetManifest" jsonb NOT NULL,
        "deletedFeedKg" numeric(18,3),
        "deletedFeedCost" numeric(18,3),
        "transactionId" bigint NOT NULL,
        "backendPid" integer NOT NULL,
        "prevDigest" char(64) NOT NULL,
        "eventDigest" char(64) NOT NULL UNIQUE,
        "catalogRevision" varchar(64) NOT NULL,
        "catalogDigest" char(64) NOT NULL,
        "requestedAt" timestamptz NOT NULL,
        "requestedBy" varchar(160) NOT NULL,
        CONSTRAINT "UQ_frrj_operation_phase"
          UNIQUE ("tenantId", "rollbackOperationId", phase),
        CONSTRAINT "CHK_frrj_phase" CHECK (phase IN ('PREPARED', 'APPLIED')),
        CONSTRAINT "CHK_frrj_count" CHECK ("recordCount" > 0),
        CONSTRAINT "CHK_frrj_manifest" CHECK (
          jsonb_typeof("targetManifest") = 'array'
          AND jsonb_array_length("targetManifest") = "recordCount"
        ),
        CONSTRAINT "CHK_frrj_digest_shape" CHECK (
          "targetSetDigest" ~ '^[0-9a-f]{64}$'
          AND "prevDigest" ~ '^[0-9a-f]{64}$'
          AND "eventDigest" ~ '^[0-9a-f]{64}$'
          AND "catalogDigest" ~ '^[0-9a-f]{64}$'
        ),
        CONSTRAINT "CHK_frrj_catalog" CHECK (
          "catalogRevision" = ${literal(AUTHORITY.schemaVersion)}
          AND "catalogDigest" = ${literal(CATALOG_DIGEST)}
        ),
        CONSTRAINT "CHK_frrj_phase_result" CHECK (
          (phase = 'PREPARED' AND "deletedFeedKg" IS NULL AND "deletedFeedCost" IS NULL)
          OR (phase = 'APPLIED' AND "deletedFeedKg" IS NOT NULL AND "deletedFeedCost" IS NOT NULL)
        )
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_frrj_backfill_operation"
        ON ${rollbackJournal} ("tenantId", "backfillOperationId", "rollbackOperationId", phase)
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION ${recordDigestFunction}(p_record_id uuid)
      RETURNS text
      LANGUAGE sql STABLE STRICT PARALLEL RESTRICTED
      SET search_path = pg_catalog
      AS $function$
        SELECT encode(pg_catalog.sha256(convert_to(
          ${literal(`aquaculture.${AUTHORITY.schemaVersion}.record|`)} ||
          jsonb_build_object(
            'actualAmount', record."actualAmount"::text,
            'batchId', record."batchId"::text,
            'batchLocationId', record."batchLocationId"::text,
            'createdAt', to_char(record."createdAt" AT TIME ZONE 'UTC',
                                 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
            'currency', record.currency,
            'dayPlanId', record."dayPlanId"::text,
            'feedCost', record."feedCost"::text,
            'feedId', record."feedId"::text,
            'feedingDate', record."feedingDate"::text,
            'feedingRecordId', record.id::text,
            'feedingTime', record."feedingTime",
            'fedBy', record."fedBy"::text,
            'mealId', record."mealId"::text,
            'plannedAmount', record."plannedAmount"::text,
            'pondId', record."pondId"::text,
            'pourIndex', record."pourIndex",
            'sourceExecutionId', record."sourceExecutionId"::text,
            'tankId', record."tankId"::text,
            'tenantId', record."tenantId"::text
          )::text,
          'UTF8'
        )), 'hex')
          FROM ${records} record
         WHERE record.id = p_record_id
      $function$
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION ${provenanceDigestFunction}(
        p_tenant_id uuid,
        p_feeding_record_id uuid,
        p_writer_authority text,
        p_operation_id text,
        p_origin text,
        p_source_execution_id uuid,
        p_record_digest text,
        p_recorded_at timestamptz
      ) RETURNS text
      LANGUAGE sql IMMUTABLE PARALLEL SAFE
      SET search_path = pg_catalog
      AS $function$
        SELECT encode(pg_catalog.sha256(convert_to(
          ${literal(`aquaculture.${AUTHORITY.schemaVersion}.provenance|`)} ||
          jsonb_build_object(
            'catalogDigest', ${literal(CATALOG_DIGEST)},
            'feedingRecordId', p_feeding_record_id::text,
            'operationId', p_operation_id,
            'origin', p_origin,
            'recordDigest', p_record_digest,
            'recordedAt', to_char(p_recorded_at AT TIME ZONE 'UTC',
                                  'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
            'schemaVersion', ${literal(AUTHORITY.schemaVersion)},
            'sourceExecutionId', p_source_execution_id::text,
            'tenantId', p_tenant_id::text,
            'writerAuthority', p_writer_authority
          )::text,
          'UTF8'
        )), 'hex')
      $function$
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION ${internalAppendFunction}(
        p_tenant_id uuid,
        p_feeding_record_id uuid,
        p_writer_authority text,
        p_operation_id text,
        p_origin text,
        p_recorded_at timestamptz
      ) RETURNS TABLE(record_digest text, provenance_digest text, replayed boolean)
      LANGUAGE plpgsql SECURITY DEFINER
      SET search_path = pg_catalog
      AS $function$
      DECLARE
        observed_tenant uuid;
        observed_source uuid;
        observed_record_digest text;
        observed_provenance_digest text;
        existing ${provenance}%ROWTYPE;
      BEGIN
        IF p_operation_id IS NULL OR length(p_operation_id) NOT BETWEEN 1 AND 160
           OR btrim(p_operation_id) <> p_operation_id OR p_recorded_at IS NULL THEN
          RAISE EXCEPTION USING ERRCODE = '55000',
            MESSAGE = 'feeding-record write provenance coordinates are not canonical';
        END IF;
        SELECT record."tenantId", record."sourceExecutionId"
          INTO observed_tenant, observed_source
          FROM ${records} record
         WHERE record.id = p_feeding_record_id
         FOR SHARE;
        IF NOT FOUND OR observed_tenant <> p_tenant_id THEN
          RAISE EXCEPTION USING ERRCODE = '55000',
            MESSAGE = 'feeding-record write provenance target is absent or cross-tenant';
        END IF;
        IF NOT (
          (p_origin = 'BACKFILL_180660'
            AND p_writer_authority = ${literal(AUTHORITY.writerAuthorities.backfill180660)}
            AND observed_source IS NOT NULL
            AND p_operation_id LIKE 'migration/180660/%')
          OR (p_origin IN ('LIVE_DRAIN', 'RUNTIME_OPERATION')
            AND p_writer_authority = ${literal(AUTHORITY.writerAuthorities.runtime)}
            AND (p_origin <> 'LIVE_DRAIN' OR observed_source IS NOT NULL))
          OR (p_origin = 'AMBIGUOUS_PRE_AUTHORITY'
            AND p_writer_authority = ${literal(AUTHORITY.writerAuthorities.legacyQuarantine)}
            AND p_operation_id = 'migration/181000/ambiguous/' || p_feeding_record_id::text)
        ) THEN
          RAISE EXCEPTION USING ERRCODE = '55000',
            MESSAGE = 'feeding-record writer authority and origin do not form an admitted pair';
        END IF;
        observed_record_digest := ${recordDigestFunction}(p_feeding_record_id);
        IF observed_record_digest IS NULL THEN
          RAISE EXCEPTION USING ERRCODE = '55000',
            MESSAGE = 'feeding-record digest authority returned no target';
        END IF;
        observed_provenance_digest := ${provenanceDigestFunction}(
          p_tenant_id, p_feeding_record_id, p_writer_authority, p_operation_id,
          p_origin, observed_source, observed_record_digest, p_recorded_at
        );
        SELECT * INTO existing
          FROM ${provenance}
         WHERE "feedingRecordId" = p_feeding_record_id;
        IF FOUND THEN
          IF ROW(existing."tenantId", existing."writerAuthority", existing."operationId",
                 existing.origin, existing."sourceExecutionId", existing."recordDigest",
                 existing."provenanceDigest", existing."recordedAt")
             IS DISTINCT FROM
             ROW(p_tenant_id, p_writer_authority, p_operation_id, p_origin, observed_source,
                 observed_record_digest, observed_provenance_digest, p_recorded_at) THEN
            RAISE EXCEPTION USING ERRCODE = '55000',
              MESSAGE = 'feeding-record write provenance replay differs from immutable authority';
          END IF;
          RETURN QUERY SELECT existing."recordDigest"::text,
                              existing."provenanceDigest"::text, true;
          RETURN;
        END IF;
        INSERT INTO ${provenance}
          ("feedingRecordId", "tenantId", "writerAuthority", "operationId", origin,
           "sourceExecutionId", "recordDigest", "catalogRevision", "catalogDigest",
           "provenanceDigest", "recordedAt")
        VALUES
          (p_feeding_record_id, p_tenant_id, p_writer_authority, p_operation_id, p_origin,
           observed_source, observed_record_digest, ${literal(AUTHORITY.schemaVersion)},
           ${literal(CATALOG_DIGEST)}, observed_provenance_digest, p_recorded_at);
        RETURN QUERY SELECT observed_record_digest, observed_provenance_digest, false;
      END
      $function$
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION ${runtimeAppendFunction}(
        p_tenant_id uuid,
        p_feeding_record_id uuid,
        p_operation_id text,
        p_origin text,
        p_recorded_at timestamptz
      ) RETURNS TABLE(record_digest text, provenance_digest text, replayed boolean)
      LANGUAGE sql SECURITY DEFINER
      SET search_path = pg_catalog
      AS $function$
        SELECT * FROM ${internalAppendFunction}(
          p_tenant_id, p_feeding_record_id,
          ${literal(AUTHORITY.writerAuthorities.runtime)}, p_operation_id, p_origin, p_recorded_at
        )
      $function$
    `);
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION ${backfillRegistrationFunction}(
        p_tenant_id uuid,
        p_feeding_record_id uuid,
        p_operation_id text,
        p_recorded_at timestamptz
      ) RETURNS TABLE(record_digest text, provenance_digest text, replayed boolean)
      LANGUAGE sql SECURITY DEFINER
      SET search_path = pg_catalog
      AS $function$
        SELECT * FROM ${internalAppendFunction}(
          p_tenant_id, p_feeding_record_id,
          ${literal(AUTHORITY.writerAuthorities.backfill180660)}, p_operation_id,
          'BACKFILL_180660', p_recorded_at
        )
      $function$
    `);

    await queryRunner.query(`
      SELECT ${internalAppendFunction}(
        record."tenantId", record.id,
        ${literal(AUTHORITY.writerAuthorities.legacyQuarantine)},
        'migration/181000/ambiguous/' || record.id::text,
        'AMBIGUOUS_PRE_AUTHORITY', record."createdAt"
      )
        FROM ${records} record
       WHERE NOT EXISTS (
         SELECT 1 FROM ${provenance} existing WHERE existing."feedingRecordId" = record.id
       )
       ORDER BY record.id
    `);
    const orphanRows: Array<{ count: string }> = await queryRunner.query(`
      SELECT COUNT(*)::text AS count
        FROM ${records} record
        LEFT JOIN ${provenance} proof ON proof."feedingRecordId" = record.id
       WHERE proof."feedingRecordId" IS NULL
          OR proof."tenantId" IS DISTINCT FROM record."tenantId"
          OR proof."sourceExecutionId" IS DISTINCT FROM record."sourceExecutionId"
    `);
    if (orphanRows[0]?.count !== '0') {
      throw new Error('Feeding-record write provenance set differs from the durable record set');
    }

    await queryRunner.query(`
      CREATE OR REPLACE VIEW ${qualified(AUTHORITY.quarantineProjection)}
      WITH (security_barrier = true, security_invoker = true) AS
      SELECT "feedingRecordId", "tenantId", "writerAuthority", "operationId", origin,
             "sourceExecutionId", "recordDigest", "provenanceDigest", "recordedAt"
        FROM ${provenance}
       WHERE origin = 'AMBIGUOUS_PRE_AUTHORITY'
    `);

    await this.installRollbackAuthority(queryRunner, {
      schema,
      records,
      batches,
      provenance,
      rollbackJournal,
      recordDigestFunction,
      rollbackDigestFunction,
      rollbackFunction,
      qualified,
    });

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION ${qualified('reject_feeding_record_provenance_mutation_v1')}()
      RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $function$
      BEGIN
        RAISE EXCEPTION USING ERRCODE = '55000',
          MESSAGE = 'feeding-record write provenance and rollback journals are append-only';
      END
      $function$;
      DROP TRIGGER IF EXISTS "TRG_frwp_append_only" ON ${provenance};
      CREATE TRIGGER "TRG_frwp_append_only" BEFORE UPDATE OR DELETE ON ${provenance}
        FOR EACH ROW EXECUTE FUNCTION ${qualified('reject_feeding_record_provenance_mutation_v1')}();
      DROP TRIGGER IF EXISTS "TRG_frrj_append_only" ON ${rollbackJournal};
      CREATE TRIGGER "TRG_frrj_append_only" BEFORE UPDATE OR DELETE ON ${rollbackJournal}
        FOR EACH ROW EXECUTE FUNCTION ${qualified('reject_feeding_record_provenance_mutation_v1')}()
    `);
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION ${qualified('assert_feeding_record_write_provenance_v1')}()
      RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $function$
      DECLARE proof ${provenance}%ROWTYPE;
      BEGIN
        SELECT * INTO proof FROM ${provenance}
         WHERE "feedingRecordId" = NEW.id;
        IF NOT FOUND
           OR proof."tenantId" IS DISTINCT FROM NEW."tenantId"
           OR proof."sourceExecutionId" IS DISTINCT FROM NEW."sourceExecutionId" THEN
          RAISE EXCEPTION USING ERRCODE = '55000',
            MESSAGE = 'feeding record has no exact immutable write provenance';
        END IF;
        RETURN NEW;
      END
      $function$;
      DROP TRIGGER IF EXISTS "TRG_feeding_record_write_provenance" ON ${records};
      CREATE CONSTRAINT TRIGGER "TRG_feeding_record_write_provenance"
        AFTER INSERT OR UPDATE OF "tenantId", "sourceExecutionId" ON ${records}
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
        EXECUTE FUNCTION ${qualified('assert_feeding_record_write_provenance_v1')}()
    `);

    await queryRunner.query(`REVOKE ALL ON ${provenance}, ${rollbackJournal} FROM PUBLIC`);
    await queryRunner.query(`
      REVOKE ALL ON FUNCTION ${internalAppendFunction}(
        uuid, uuid, text, text, text, timestamptz
      ) FROM PUBLIC;
      REVOKE ALL ON FUNCTION ${runtimeAppendFunction}(
        uuid, uuid, text, text, timestamptz
      ) FROM PUBLIC;
      REVOKE ALL ON FUNCTION ${backfillRegistrationFunction}(
        uuid, uuid, text, timestamptz
      ) FROM PUBLIC;
      REVOKE ALL ON FUNCTION ${rollbackFunction}(
        uuid, text, text, integer, text, timestamptz, text
      ) FROM PUBLIC
    `);
    await queryRunner.query(`
      DO $roles$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'farm_service') THEN
          GRANT EXECUTE ON FUNCTION ${runtimeAppendFunction}(
            uuid, uuid, text, text, timestamptz
          ) TO farm_service;
          GRANT SELECT ON ${provenance},
            ${qualified(AUTHORITY.quarantineProjection)} TO farm_service;
        END IF;
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'db_migrate') THEN
          GRANT EXECUTE ON FUNCTION ${backfillRegistrationFunction}(
            uuid, uuid, text, timestamptz
          ) TO db_migrate;
          GRANT EXECUTE ON FUNCTION ${rollbackFunction}(
            uuid, text, text, integer, text, timestamptz, text
          ) TO db_migrate;
          GRANT SELECT ON ${provenance}, ${rollbackJournal} TO db_migrate;
        END IF;
      END
      $roles$
    `);
  }

  private async installRollbackAuthority(
    queryRunner: QueryRunner,
    names: {
      readonly schema: string;
      readonly records: string;
      readonly batches: string;
      readonly provenance: string;
      readonly rollbackJournal: string;
      readonly recordDigestFunction: string;
      readonly rollbackDigestFunction: string;
      readonly rollbackFunction: string;
      readonly qualified: (name: string) => string;
    },
  ): Promise<void> {
    const {
      records,
      batches,
      provenance,
      rollbackJournal,
      recordDigestFunction,
      rollbackDigestFunction,
      rollbackFunction,
      qualified,
    } = names;
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION ${rollbackDigestFunction}(
        p_tenant_id uuid,
        p_rollback_operation_id text,
        p_backfill_operation_id text,
        p_phase text,
        p_target_set_digest text,
        p_record_count integer,
        p_target_manifest jsonb,
        p_deleted_feed_kg numeric,
        p_deleted_feed_cost numeric,
        p_transaction_id bigint,
        p_backend_pid integer,
        p_prev_digest text,
        p_requested_at timestamptz,
        p_requested_by text
      ) RETURNS text
      LANGUAGE sql IMMUTABLE PARALLEL SAFE
      SET search_path = pg_catalog
      AS $function$
        SELECT encode(pg_catalog.sha256(convert_to(
          ${literal(`aquaculture.${AUTHORITY.schemaVersion}.rollback-event|`)} ||
          jsonb_build_object(
            'backendPid', p_backend_pid,
            'backfillOperationId', p_backfill_operation_id,
            'catalogDigest', ${literal(CATALOG_DIGEST)},
            'deletedFeedCost', p_deleted_feed_cost::text,
            'deletedFeedKg', p_deleted_feed_kg::text,
            'phase', p_phase,
            'prevDigest', p_prev_digest,
            'recordCount', p_record_count,
            'requestedAt', to_char(p_requested_at AT TIME ZONE 'UTC',
                                   'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
            'requestedBy', p_requested_by,
            'rollbackOperationId', p_rollback_operation_id,
            'schemaVersion', ${literal(AUTHORITY.schemaVersion)},
            'targetManifest', p_target_manifest,
            'targetSetDigest', p_target_set_digest,
            'tenantId', p_tenant_id::text,
            'transactionId', p_transaction_id
          )::text,
          'UTF8'
        )), 'hex')
      $function$
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION ${qualified('authorize_feeding_record_backfill_delete_v1')}()
      RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $function$
      DECLARE proof ${provenance}%ROWTYPE;
      DECLARE observed_digest text;
      BEGIN
        IF OLD."sourceExecutionId" IS NULL THEN RETURN OLD; END IF;
        SELECT * INTO proof FROM ${provenance}
         WHERE "feedingRecordId" = OLD.id AND "tenantId" = OLD."tenantId";
        IF NOT FOUND THEN
          RAISE EXCEPTION USING ERRCODE = '55000',
            MESSAGE = 'feeding-record delete has no immutable write provenance';
        END IF;
        observed_digest := ${recordDigestFunction}(OLD.id);
        IF proof.origin <> 'BACKFILL_180660'
           OR proof."sourceExecutionId" IS DISTINCT FROM OLD."sourceExecutionId"
           OR proof."recordDigest" IS DISTINCT FROM observed_digest
           OR NOT EXISTS (
             SELECT 1 FROM ${rollbackJournal} auth_event
              WHERE auth_event."tenantId" = OLD."tenantId"
                AND auth_event."backfillOperationId" = proof."operationId"
                AND auth_event.phase = 'PREPARED'
                AND auth_event."transactionId" = txid_current()
                AND auth_event."backendPid" = pg_backend_pid()
                AND auth_event."targetManifest" @> jsonb_build_array(jsonb_build_object(
                  'feedingRecordId', OLD.id::text,
                  'recordDigest', proof."recordDigest"::text
                ))
           ) THEN
          RAISE EXCEPTION USING ERRCODE = '55000',
            MESSAGE = 'feeding-record delete lacks exact BACKFILL_180660 rollback authority';
        END IF;
        RETURN OLD;
      END
      $function$;
      DROP TRIGGER IF EXISTS "TRG_historical_feeding_record_no_delete" ON ${records};
      DROP FUNCTION IF EXISTS ${qualified('reject_historical_feeding_record_delete_v1')}();
      CREATE TRIGGER "TRG_historical_feeding_record_no_delete"
        BEFORE DELETE ON ${records} FOR EACH ROW
        EXECUTE FUNCTION ${qualified('authorize_feeding_record_backfill_delete_v1')}()
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION ${rollbackFunction}(
        p_tenant_id uuid,
        p_backfill_operation_id text,
        p_expected_target_set_digest text,
        p_expected_record_count integer,
        p_rollback_operation_id text,
        p_requested_at timestamptz,
        p_requested_by text
      ) RETURNS TABLE(
        deleted_count integer,
        target_set_digest text,
        journal_digest text,
        replayed boolean
      )
      LANGUAGE plpgsql SECURITY DEFINER
      SET search_path = pg_catalog
      AS $function$
      DECLARE
        applied ${rollbackJournal}%ROWTYPE;
        observed_count integer;
        non_backfill_count integer;
        missing_record_count integer;
        changed_record_count integer;
        observed_manifest jsonb;
        observed_target_set_digest text;
        prepared_digest text;
        applied_digest text;
        transaction_id bigint;
        backend_pid integer;
        removed_count integer;
        removed_feed_kg numeric(18,3);
        removed_feed_cost numeric(18,3);
      BEGIN
        IF p_backfill_operation_id IS NULL
           OR length(p_backfill_operation_id) NOT BETWEEN 1 AND 160
           OR btrim(p_backfill_operation_id) <> p_backfill_operation_id
           OR p_rollback_operation_id IS NULL
           OR length(p_rollback_operation_id) NOT BETWEEN 1 AND 160
           OR btrim(p_rollback_operation_id) <> p_rollback_operation_id
           OR p_requested_by IS NULL OR length(p_requested_by) NOT BETWEEN 1 AND 160
           OR btrim(p_requested_by) <> p_requested_by
           OR p_requested_at IS NULL
           OR p_expected_record_count IS NULL OR p_expected_record_count <= 0
           OR p_expected_target_set_digest !~ '^[0-9a-f]{64}$' THEN
          RAISE EXCEPTION USING ERRCODE = '55000',
            MESSAGE = 'feeding-record rollback request coordinates are not canonical';
        END IF;

        SELECT * INTO applied FROM ${rollbackJournal} event
         WHERE event."tenantId" = p_tenant_id
           AND event."rollbackOperationId" = p_rollback_operation_id
           AND event.phase = 'APPLIED';
        IF FOUND THEN
          IF applied."backfillOperationId" <> p_backfill_operation_id
             OR applied."targetSetDigest" <> p_expected_target_set_digest
             OR applied."recordCount" <> p_expected_record_count
             OR applied."requestedAt" <> p_requested_at
             OR applied."requestedBy" <> p_requested_by THEN
            RAISE EXCEPTION USING ERRCODE = '55000',
              MESSAGE = 'feeding-record rollback retry differs from immutable journal';
          END IF;
          RETURN QUERY SELECT applied."recordCount", applied."targetSetDigest"::text,
                              applied."eventDigest"::text, true;
          RETURN;
        END IF;
        IF EXISTS (
          SELECT 1 FROM ${rollbackJournal} event
           WHERE event."tenantId" = p_tenant_id
             AND event."rollbackOperationId" = p_rollback_operation_id
        ) THEN
          RAISE EXCEPTION USING ERRCODE = '55000',
            MESSAGE = 'feeding-record rollback journal has no terminal APPLIED event';
        END IF;

        PERFORM record.id
          FROM ${records} record
          JOIN ${provenance} proof ON proof."feedingRecordId" = record.id
         WHERE proof."tenantId" = p_tenant_id
           AND proof."operationId" = p_backfill_operation_id
         ORDER BY record.id FOR UPDATE OF record;

        SELECT COUNT(*)::integer,
               COUNT(*) FILTER (WHERE proof.origin <> 'BACKFILL_180660')::integer,
               COUNT(*) FILTER (WHERE record.id IS NULL)::integer,
               COUNT(*) FILTER (
                 WHERE record.id IS NOT NULL
                   AND proof."recordDigest" <> ${recordDigestFunction}(proof."feedingRecordId")
               )::integer,
               jsonb_agg(jsonb_build_object(
                 'feedingRecordId', proof."feedingRecordId"::text,
                 'recordDigest', proof."recordDigest"::text
               ) ORDER BY proof."feedingRecordId"),
               encode(pg_catalog.sha256(convert_to(COALESCE(string_agg(
                 length(proof."feedingRecordId"::text)::text || ':' ||
                 proof."feedingRecordId"::text || '|' || proof."recordDigest"::text,
                 E'\\n' ORDER BY proof."feedingRecordId"
               ), ''), 'UTF8')), 'hex')
          INTO observed_count, non_backfill_count, missing_record_count,
               changed_record_count, observed_manifest, observed_target_set_digest
          FROM ${provenance} proof
          LEFT JOIN ${records} record ON record.id = proof."feedingRecordId"
         WHERE proof."tenantId" = p_tenant_id
           AND proof."operationId" = p_backfill_operation_id;

        IF observed_count = 0 OR non_backfill_count <> 0 OR missing_record_count <> 0
           OR changed_record_count <> 0
           OR observed_count <> p_expected_record_count
           OR observed_target_set_digest <> p_expected_target_set_digest THEN
          RAISE EXCEPTION USING ERRCODE = '55000',
            MESSAGE = 'feeding-record rollback exact BACKFILL_180660 set qualification failed';
        END IF;

        IF EXISTS (
          SELECT 1
            FROM (
              SELECT record."batchId", SUM(record."actualAmount") AS feed_kg,
                     SUM(COALESCE(record."feedCost", 0)) AS feed_cost
                FROM ${records} record
                JOIN ${provenance} proof ON proof."feedingRecordId" = record.id
               WHERE proof."tenantId" = p_tenant_id
                 AND proof."operationId" = p_backfill_operation_id
               GROUP BY record."batchId"
            ) expected
            LEFT JOIN ${batches} batch ON batch.id = expected."batchId"
           WHERE batch.id IS NULL
              OR COALESCE(batch."totalFeedConsumed", 0) < expected.feed_kg
              OR COALESCE(batch."totalFeedCost", 0) < expected.feed_cost
        ) THEN
          RAISE EXCEPTION USING ERRCODE = '55000',
            MESSAGE = 'feeding-record rollback aggregate coordinates are inconsistent';
        END IF;

        transaction_id := txid_current();
        backend_pid := pg_backend_pid();
        prepared_digest := ${rollbackDigestFunction}(
          p_tenant_id, p_rollback_operation_id, p_backfill_operation_id, 'PREPARED',
          observed_target_set_digest, observed_count, observed_manifest, NULL, NULL,
          transaction_id, backend_pid, ${literal(ROOT_DIGEST)}, p_requested_at, p_requested_by
        );
        INSERT INTO ${rollbackJournal}
          ("tenantId", "rollbackOperationId", "backfillOperationId", phase,
           "targetSetDigest", "recordCount", "targetManifest", "deletedFeedKg",
           "deletedFeedCost", "transactionId", "backendPid", "prevDigest", "eventDigest",
           "catalogRevision", "catalogDigest", "requestedAt", "requestedBy")
        VALUES
          (p_tenant_id, p_rollback_operation_id, p_backfill_operation_id, 'PREPARED',
           observed_target_set_digest, observed_count, observed_manifest, NULL, NULL,
           transaction_id, backend_pid, ${literal(ROOT_DIGEST)}, prepared_digest,
           ${literal(AUTHORITY.schemaVersion)}, ${literal(CATALOG_DIGEST)},
           p_requested_at, p_requested_by);

        WITH removed AS (
          DELETE FROM ${records} record
           USING ${provenance} proof
           WHERE proof."feedingRecordId" = record.id
             AND proof."tenantId" = p_tenant_id
             AND proof."operationId" = p_backfill_operation_id
             AND proof.origin = 'BACKFILL_180660'
           RETURNING record."batchId", record."actualAmount", COALESCE(record."feedCost", 0) AS cost
        ), aggregate_delta AS (
          SELECT "batchId", SUM("actualAmount") AS feed_kg, SUM(cost) AS feed_cost
            FROM removed GROUP BY "batchId"
        ), updated AS (
          UPDATE ${batches} batch
             SET "totalFeedConsumed" = COALESCE(batch."totalFeedConsumed", 0) - delta.feed_kg,
                 "totalFeedCost" = COALESCE(batch."totalFeedCost", 0) - delta.feed_cost
            FROM aggregate_delta delta
           WHERE batch.id = delta."batchId"
           RETURNING batch.id
        )
        SELECT COUNT(*)::integer, COALESCE(SUM("actualAmount"), 0), COALESCE(SUM(cost), 0)
          INTO removed_count, removed_feed_kg, removed_feed_cost
          FROM removed;
        IF removed_count <> observed_count THEN
          RAISE EXCEPTION USING ERRCODE = '55000',
            MESSAGE = 'feeding-record rollback mutated a non-exact record count';
        END IF;

        applied_digest := ${rollbackDigestFunction}(
          p_tenant_id, p_rollback_operation_id, p_backfill_operation_id, 'APPLIED',
          observed_target_set_digest, observed_count, observed_manifest,
          removed_feed_kg, removed_feed_cost, transaction_id, backend_pid,
          prepared_digest, p_requested_at, p_requested_by
        );
        INSERT INTO ${rollbackJournal}
          ("tenantId", "rollbackOperationId", "backfillOperationId", phase,
           "targetSetDigest", "recordCount", "targetManifest", "deletedFeedKg",
           "deletedFeedCost", "transactionId", "backendPid", "prevDigest", "eventDigest",
           "catalogRevision", "catalogDigest", "requestedAt", "requestedBy")
        VALUES
          (p_tenant_id, p_rollback_operation_id, p_backfill_operation_id, 'APPLIED',
           observed_target_set_digest, observed_count, observed_manifest,
           removed_feed_kg, removed_feed_cost, transaction_id, backend_pid,
           prepared_digest, applied_digest, ${literal(AUTHORITY.schemaVersion)},
           ${literal(CATALOG_DIGEST)}, p_requested_at, p_requested_by);
        RETURN QUERY SELECT removed_count, observed_target_set_digest, applied_digest, false;
      END
      $function$
    `);
  }

  public async postCondition(queryRunner: QueryRunner): Promise<boolean> {
    const rows: Array<{ ok: boolean }> = await queryRunner.query(`
      SELECT (
        to_regclass(${literal(AUTHORITY.relation)}) IS NOT NULL
        AND to_regclass(${literal(AUTHORITY.rollback.relation)}) IS NOT NULL
        AND to_regclass(${literal(AUTHORITY.quarantineProjection)}) IS NOT NULL
        AND to_regprocedure(${literal(`${AUTHORITY.appendFunction}(uuid,uuid,text,text,timestamp with time zone)`)}) IS NOT NULL
        AND to_regprocedure(${literal(`${AUTHORITY.backfillRegistrationFunction}(uuid,uuid,text,timestamp with time zone)`)}) IS NOT NULL
        AND to_regprocedure(${literal(`${AUTHORITY.rollback.function}(uuid,text,text,integer,text,timestamp with time zone,text)`)}) IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM feeding_records record
          LEFT JOIN ${identifier(AUTHORITY.relation)} proof ON proof."feedingRecordId" = record.id
          WHERE proof."feedingRecordId" IS NULL
             OR proof."tenantId" IS DISTINCT FROM record."tenantId"
             OR proof."sourceExecutionId" IS DISTINCT FROM record."sourceExecutionId"
        )
      ) AS ok
    `);
    return rows[0]?.ok === true;
  }

  public async down(): Promise<void> {
    // Forward-only: provenance and destructive-operation evidence are durable authority state.
  }
}
