import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ProtectFeedingRecordBackfillProvenance1808600000000
 *
 * `BackfillExecutionsToFeedingRecords1806600000000.down()` predates durable
 * row ownership. Its delete predicate also matches live drain records, so a
 * rollback could remove facts written by FeedingLedgerService.
 *
 * This forward-only migration establishes an immutable ownership ledger and a
 * database delete fence. The original backfill rows are identified by a
 * PostgreSQL transaction invariant: the migration ledger row and every row
 * inserted by 180660 commit in the same per-migration transaction and therefore
 * carry the same `xmin`. No content-shape heuristic is used.
 *
 * Existing matching rows without that proof are UNKNOWN and fail closed.
 * Matching rows inserted after this migration are captured as LIVE_DRAIN by an
 * AFTER INSERT trigger. The delete fence permits only proven BACKFILL_180660
 * rows, suppresses deletion of LIVE_DRAIN rows, and rejects UNKNOWN rows.
 *
 * All objects are search_path-relative because farm data is tenant-scoped and
 * the migration runner fans this migration out over the source and every
 * `tenant_<uuid>` schema. Full tenant erasure never grants a delete capability
 * to farm_service: tenant-ledger rows leave with the proof-gated db-migrate
 * schema DROP, while that same job removes legacy source-schema residue under
 * an exact transaction-local operation/tenant context.
 */
export class ProtectFeedingRecordBackfillProvenance1808600000000 implements MigrationInterface {
  public readonly name = 'ProtectFeedingRecordBackfillProvenance1808600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '120s'`);

    await queryRunner.query(`
      DO $guard$
      DECLARE
        ledger_table_name text := CASE
          WHEN current_schema() = 'farm' THEN 'migrations'
          ELSE 'migrations_farm'
        END;
      BEGIN
        IF to_regclass(current_schema() || '.feeding_records') IS NULL THEN
          RAISE EXCEPTION
            'FARM-CRITICAL-241: feeding_records is absent from schema %',
            current_schema();
        END IF;
        IF to_regclass(format('%I.%I', current_schema(), ledger_table_name)) IS NULL THEN
          RAISE EXCEPTION
            'FARM-CRITICAL-241: TypeORM migration ledger %.% is absent',
            current_schema(),
            ledger_table_name;
        END IF;
      END
      $guard$;
    `);

    // Close the insert/classification race: no feeding writer can slip between
    // xmin classification and trigger installation in this transaction.
    await queryRunner.query(`LOCK TABLE feeding_records IN SHARE ROW EXCLUSIVE MODE`);

    // Remember whether this is a true first install or a re-application after
    // forward-only down(). On re-apply the four retained triggers make the
    // immutable ledger canonical: current feeding rows may legitimately have
    // newer xmin/content after ordinary updates, so insertion-time evidence
    // must not be recomputed. A merely pre-created/unprotected table does not
    // satisfy this marker and is subjected to exact collision validation.
    await queryRunner.query(`
      SELECT pg_catalog.set_config(
        'aqua.feeding_provenance_preprotected',
        CASE
          WHEN to_regclass(current_schema() || '.feeding_record_provenance') IS NOT NULL
           AND (
             SELECT COUNT(*) = 4
             FROM pg_trigger
             WHERE (
               (
                 tgrelid = to_regclass(
                   current_schema() || '.feeding_record_provenance'
                 )
                 AND tgname = ANY(ARRAY[
                   'trg_feeding_record_provenance_immutable',
                   'trg_feeding_record_provenance_immutable_truncate'
                 ])
               )
               OR (
                 tgrelid = to_regclass(current_schema() || '.feeding_records')
                 AND tgname = ANY(ARRAY[
                   'trg_feeding_records_capture_live_drain_provenance',
                   'trg_feeding_records_guard_provenance_delete'
                 ])
               )
             )
               AND NOT tgisinternal
           )
          THEN 'on'
          ELSE 'off'
        END,
        true
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS feeding_record_provenance (
        feeding_record_id uuid PRIMARY KEY,
        tenant_id uuid NOT NULL,
        source_execution_id uuid NOT NULL,
        origin varchar(32) NOT NULL,
        source_xmin text NOT NULL,
        content_hash char(32) NOT NULL,
        classified_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        CONSTRAINT ck_feeding_record_provenance_origin
          CHECK (origin IN ('BACKFILL_180660', 'LIVE_DRAIN', 'UNKNOWN'))
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_feeding_record_provenance_tenant_execution
        ON feeding_record_provenance (tenant_id, source_execution_id)
    `);
    await queryRunner.query(`
      REVOKE INSERT, UPDATE, DELETE, TRUNCATE
        ON feeding_record_provenance FROM PUBLIC
    `);
    await queryRunner.query(`
      DO $privileges$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'farm_service') THEN
          REVOKE INSERT, UPDATE, DELETE, TRUNCATE
            ON feeding_record_provenance FROM farm_service;
          GRANT SELECT ON feeding_record_provenance TO farm_service;
        END IF;
      END
      $privileges$;
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION reject_feeding_record_provenance_mutation()
      RETURNS trigger
      LANGUAGE plpgsql
      SET search_path FROM CURRENT
      AS $function$
      BEGIN
        IF TG_OP = 'TRUNCATE' THEN
          RAISE EXCEPTION
            'FARM-CRITICAL-241: feeding_record_provenance is immutable (TRUNCATE)'
            USING ERRCODE = '55000';
        END IF;

        -- Full tenant erasure is completed only by the proof-gated
        -- aqua-db-migrate DELETE job. Tenant-schema rows disappear with the
        -- protected DROP SCHEMA; this narrow source-schema exception lets the
        -- same transaction remove any legacy farm-schema residue for exactly
        -- the attested tenant. Runtime farm_service sessions cannot satisfy
        -- the independent db_migrate role check.
        IF TG_OP = 'DELETE'
           AND current_schema() = 'farm'
           AND NULLIF(
             current_setting('aqua.tenant_schema_delete_operation', true),
             ''
           ) IS NOT NULL THEN
          IF NOT pg_has_role(session_user, 'db_migrate', 'USAGE')
             OR current_setting('aqua.tenant_schema_delete_tenant', true)
                  IS DISTINCT FROM OLD.tenant_id::text THEN
            RAISE EXCEPTION
              'FARM-CRITICAL-241: unauthorized source provenance erasure for tenant %',
              OLD.tenant_id
              USING ERRCODE = '42501';
          END IF;
          RETURN OLD;
        END IF;

        RAISE EXCEPTION
          'FARM-CRITICAL-241: feeding_record_provenance is immutable (% for record %)',
          TG_OP,
          OLD.feeding_record_id
          USING ERRCODE = '55000';
      END
      $function$
    `);
    await queryRunner.query(`
      DO $trigger$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_trigger
          WHERE tgrelid = 'feeding_record_provenance'::regclass
            AND tgname = 'trg_feeding_record_provenance_immutable'
            AND NOT tgisinternal
        ) THEN
          CREATE TRIGGER trg_feeding_record_provenance_immutable
          BEFORE UPDATE OR DELETE ON feeding_record_provenance
          FOR EACH ROW
          EXECUTE FUNCTION reject_feeding_record_provenance_mutation();
        END IF;
      END
      $trigger$;
    `);
    await queryRunner.query(`
      DO $trigger$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_trigger
          WHERE tgrelid = 'feeding_record_provenance'::regclass
            AND tgname = 'trg_feeding_record_provenance_immutable_truncate'
            AND NOT tgisinternal
        ) THEN
          CREATE TRIGGER trg_feeding_record_provenance_immutable_truncate
          BEFORE TRUNCATE ON feeding_record_provenance
          FOR EACH STATEMENT
          EXECUTE FUNCTION reject_feeding_record_provenance_mutation();
        END IF;
      END
      $trigger$;
    `);

    await queryRunner.query(`
      DO $classification$
      DECLARE
        ledger_table_name text := CASE
          WHEN current_schema() = 'farm' THEN 'migrations'
          ELSE 'migrations_farm'
        END;
        conflicting_record_id uuid;
      BEGIN
        IF current_setting(
             'aqua.feeding_provenance_preprotected',
             true
           ) IS DISTINCT FROM 'on' THEN
          EXECUTE format(
          $sql$
            WITH backfill_migration_transaction AS (
              SELECT m.xmin AS transaction_xmin
              FROM %I.%I m
              WHERE m.timestamp = 1806600000000
                AND m.name = 'BackfillExecutionsToFeedingRecords1806600000000'
              ORDER BY m.id DESC
              LIMIT 1
            ), expected AS (
              SELECT fr.id AS feeding_record_id,
                     fr."tenantId" AS tenant_id,
                     fr."sourceExecutionId" AS source_execution_id,
                     CASE
                       WHEN EXISTS (
                         SELECT 1
                         FROM backfill_migration_transaction migration_tx
                         WHERE migration_tx.transaction_xmin = fr.xmin
                       ) THEN 'BACKFILL_180660'
                       ELSE 'UNKNOWN'
                     END::varchar(32) AS origin,
                     fr.xmin::text AS source_xmin,
                     md5(to_jsonb(fr)::text)::char(32) AS content_hash
              FROM feeding_records fr
              WHERE fr."sourceExecutionId" IS NOT NULL
                AND fr."mealId" IS NULL
            )
            SELECT expected.feeding_record_id
            FROM expected
            JOIN feeding_record_provenance provenance
              ON provenance.feeding_record_id = expected.feeding_record_id
            WHERE provenance.tenant_id IS DISTINCT FROM expected.tenant_id
               OR provenance.source_execution_id IS DISTINCT FROM expected.source_execution_id
               OR provenance.origin IS DISTINCT FROM expected.origin
               OR provenance.source_xmin IS DISTINCT FROM expected.source_xmin
               OR provenance.content_hash IS DISTINCT FROM expected.content_hash
            ORDER BY expected.feeding_record_id
            LIMIT 1
          $sql$,
          current_schema(),
          ledger_table_name
          ) INTO conflicting_record_id;

          IF conflicting_record_id IS NOT NULL THEN
            RAISE EXCEPTION
              'FARM-CRITICAL-241: conflicting classified provenance exists for feeding record %',
              conflicting_record_id
              USING ERRCODE = '23505';
          END IF;
        END IF;

        EXECUTE format(
          $sql$
            WITH backfill_migration_transaction AS (
              SELECT m.xmin AS transaction_xmin
              FROM %I.%I m
              WHERE m.timestamp = 1806600000000
                AND m.name = 'BackfillExecutionsToFeedingRecords1806600000000'
              ORDER BY m.id DESC
              LIMIT 1
            ), expected AS (
              SELECT fr.id AS feeding_record_id,
                     fr."tenantId" AS tenant_id,
                     fr."sourceExecutionId" AS source_execution_id,
                     CASE
                       WHEN EXISTS (
                         SELECT 1
                         FROM backfill_migration_transaction migration_tx
                         WHERE migration_tx.transaction_xmin = fr.xmin
                       ) THEN 'BACKFILL_180660'
                       ELSE 'UNKNOWN'
                     END::varchar(32) AS origin,
                     fr.xmin::text AS source_xmin,
                     md5(to_jsonb(fr)::text)::char(32) AS content_hash
              FROM feeding_records fr
              WHERE fr."sourceExecutionId" IS NOT NULL
                AND fr."mealId" IS NULL
            )
            INSERT INTO feeding_record_provenance
              (feeding_record_id, tenant_id, source_execution_id, origin,
               source_xmin, content_hash, classified_at)
            SELECT expected.feeding_record_id,
                   expected.tenant_id,
                   expected.source_execution_id,
                   expected.origin,
                   expected.source_xmin,
                   expected.content_hash,
                   clock_timestamp()
            FROM expected
            LEFT JOIN feeding_record_provenance provenance
              ON provenance.feeding_record_id = expected.feeding_record_id
            WHERE provenance.feeding_record_id IS NULL
          $sql$,
          current_schema(),
          ledger_table_name
        );
      END
      $classification$;
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION capture_live_drain_feeding_record_provenance()
      RETURNS trigger
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path FROM CURRENT
      AS $function$
      DECLARE
        expected_origin varchar(32);
        expected_xmin text;
        expected_hash char(32);
        new_row jsonb;
        new_source_execution_id uuid;
        existing_origin varchar(32);
        existing_tenant_id uuid;
        existing_source_execution_id uuid;
        existing_source_xmin text;
        existing_content_hash char(32);
      BEGIN
        new_row := to_jsonb(NEW);
        -- 180680 is deliberately forward-only and therefore survives a deep
        -- rollback past 180640, where these two columns no longer exist. JSON
        -- extraction makes the retained trigger a no-op on that older shape.
        IF new_row ? 'sourceExecutionId'
           AND new_row->>'sourceExecutionId' IS NOT NULL
           AND (
             NOT (new_row ? 'mealId')
             OR new_row->>'mealId' IS NULL
           ) THEN
          new_source_execution_id := (new_row->>'sourceExecutionId')::uuid;
          IF current_setting('aqua.migration_name', true) =
               'BackfillExecutionsToFeedingRecords1806600000000'
             AND current_setting('aqua.migration_direction', true) = 'up' THEN
            IF NOT pg_has_role(session_user, 'db_migrate', 'USAGE') THEN
              RAISE EXCEPTION
                'FARM-CRITICAL-241: 180660/up provenance requires db_migrate authority'
                USING ERRCODE = '42501';
            END IF;
            expected_origin := 'BACKFILL_180660';
          ELSE
            expected_origin := 'LIVE_DRAIN';
          END IF;

          expected_xmin := NEW.xmin::text;
          expected_hash := md5(new_row::text);

          BEGIN
            INSERT INTO feeding_record_provenance
              (feeding_record_id, tenant_id, source_execution_id, origin,
               source_xmin, content_hash, classified_at)
            VALUES
              (NEW.id, NEW."tenantId", new_source_execution_id, expected_origin,
               expected_xmin, expected_hash, clock_timestamp());
          EXCEPTION WHEN unique_violation THEN
            SELECT provenance.origin,
                   provenance.tenant_id,
                   provenance.source_execution_id,
                   provenance.source_xmin,
                   provenance.content_hash
              INTO existing_origin,
                   existing_tenant_id,
                   existing_source_execution_id,
                   existing_source_xmin,
                   existing_content_hash
              FROM feeding_record_provenance provenance
             WHERE provenance.feeding_record_id = NEW.id;

            IF existing_origin IS DISTINCT FROM expected_origin
               OR existing_tenant_id IS DISTINCT FROM NEW."tenantId"
               OR existing_source_execution_id IS DISTINCT FROM new_source_execution_id
               OR existing_source_xmin IS DISTINCT FROM expected_xmin
               OR existing_content_hash IS DISTINCT FROM expected_hash THEN
              RAISE EXCEPTION
                'FARM-CRITICAL-241: conflicting provenance already exists for feeding record %',
                NEW.id
                USING ERRCODE = '23505';
            END IF;
          END;
        END IF;
        RETURN NEW;
      END
      $function$
    `);
    await queryRunner.query(`
      DO $trigger$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_trigger
          WHERE tgrelid = 'feeding_records'::regclass
            AND tgname = 'trg_feeding_records_capture_live_drain_provenance'
            AND NOT tgisinternal
        ) THEN
          CREATE TRIGGER trg_feeding_records_capture_live_drain_provenance
          AFTER INSERT ON feeding_records
          FOR EACH ROW
          EXECUTE FUNCTION capture_live_drain_feeding_record_provenance();
        END IF;
      END
      $trigger$;
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION guard_feeding_record_provenance_delete()
      RETURNS trigger
      LANGUAGE plpgsql
      SET search_path FROM CURRENT
      AS $function$
      DECLARE
        recorded_origin varchar(32);
        old_row jsonb;
      BEGIN
        IF current_setting('aqua.migration_name', true) IS DISTINCT FROM
             'BackfillExecutionsToFeedingRecords1806600000000'
           OR current_setting('aqua.migration_direction', true) IS DISTINCT FROM 'down' THEN
          RETURN OLD;
        END IF;

        IF NOT pg_has_role(session_user, 'db_migrate', 'USAGE') THEN
          RAISE EXCEPTION
            'FARM-CRITICAL-241: 180660/down rollback requires db_migrate authority'
            USING ERRCODE = '42501';
        END IF;

        old_row := to_jsonb(OLD);
        IF old_row->>'sourceExecutionId' IS NULL OR old_row->>'mealId' IS NOT NULL THEN
          RETURN OLD;
        END IF;

        SELECT provenance.origin
          INTO recorded_origin
          FROM feeding_record_provenance provenance
         WHERE provenance.feeding_record_id = OLD.id;

        IF recorded_origin = 'BACKFILL_180660' THEN
          RETURN OLD;
        END IF;

        IF recorded_origin = 'LIVE_DRAIN' THEN
          RETURN NULL;
        END IF;

        RAISE EXCEPTION
          'FARM-CRITICAL-241: refusing to delete feeding record % with provenance %',
          OLD.id,
          COALESCE(recorded_origin, 'UNKNOWN')
          USING ERRCODE = '55000';
      END
      $function$
    `);
    await queryRunner.query(`
      DO $trigger$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_trigger
          WHERE tgrelid = 'feeding_records'::regclass
            AND tgname = 'trg_feeding_records_guard_provenance_delete'
            AND NOT tgisinternal
        ) THEN
          CREATE TRIGGER trg_feeding_records_guard_provenance_delete
          BEFORE DELETE ON feeding_records
          FOR EACH ROW
          EXECUTE FUNCTION guard_feeding_record_provenance_delete();
        END IF;
      END
      $trigger$;
    `);
  }

  public async down(): Promise<void> {
    // Forward-only protection: provenance, capture, immutability, and the
    // context-scoped 180660 rollback fence must survive before TypeORM reaches
    // 180660.down. Normal application/retention deletes remain unaffected
    // because the delete trigger activates only inside exact 180660/down
    // migration context held by db_migrate.
  }
}
