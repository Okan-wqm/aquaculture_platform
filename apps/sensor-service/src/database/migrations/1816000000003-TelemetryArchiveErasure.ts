import { MigrationInterface, QueryRunner } from 'typeorm';

export const TELEMETRY_ARCHIVE_ERASURE_UP_STATEMENTS = [
  `ALTER TABLE sensor.telemetry_archive_events
     ADD COLUMN bucket_name text,
     ADD COLUMN object_version_id text,
     ADD COLUMN archive_format varchar(10),
     ADD COLUMN min_time timestamptz,
     ADD COLUMN max_time timestamptz,
     ADD CONSTRAINT CHK_telemetry_archive_format
       CHECK (archive_format IS NULL OR archive_format = 'PARQUET'),
     ADD CONSTRAINT CHK_telemetry_archive_object_version
       CHECK (object_version_id IS NULL OR length(object_version_id) BETWEEN 1 AND 1024),
     ADD CONSTRAINT CHK_telemetry_archive_time_bounds
       CHECK (
         (min_time IS NULL AND max_time IS NULL)
         OR (min_time IS NOT NULL AND max_time IS NOT NULL AND min_time <= max_time)
       )`,
  `CREATE TABLE sensor.telemetry_archive_presigns (
     presign_id uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
     tenant_id uuid NOT NULL,
     operation_id uuid NOT NULL,
     url_sha256 character(64) NOT NULL CHECK (url_sha256 ~ '^[0-9a-f]{64}$'),
     expires_at timestamptz NOT NULL,
     revoked_at timestamptz,
     recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
   )`,
  `CREATE INDEX IDX_telemetry_archive_presigns_tenant
     ON sensor.telemetry_archive_presigns (tenant_id, expires_at)`,
  `CREATE TABLE sensor.telemetry_archive_cancellations (
     tenant_id uuid PRIMARY KEY,
     erasure_operation_id uuid NOT NULL,
     cancelled_at timestamptz NOT NULL DEFAULT clock_timestamp()
   )`,
  `REVOKE ALL ON sensor.telemetry_archive_presigns,
     sensor.telemetry_archive_cancellations FROM PUBLIC, sensor_service`,
  `ALTER FUNCTION sensor.append_telemetry_archive_event(
     uuid, uuid, text, timestamptz, timestamptz, uuid, text, bigint, text,
     integer, text, text, text
   ) RENAME TO append_telemetry_archive_event_state_machine`,
  `REVOKE ALL ON FUNCTION sensor.append_telemetry_archive_event_state_machine(
     uuid, uuid, text, timestamptz, timestamptz, uuid, text, bigint, text,
     integer, text, text, text
   ) FROM PUBLIC, sensor_service`,
  `CREATE OR REPLACE FUNCTION sensor.telemetry_archive_events_immutable()
   RETURNS trigger
   LANGUAGE plpgsql
   SET search_path = pg_catalog, sensor
   AS $$
   BEGIN
     IF TG_OP = 'UPDATE'
        AND current_setting('app.telemetry_archive_internal_event_id', true) = OLD.event_id::text
        AND NEW.event_id = OLD.event_id
        AND NEW.operation_id = OLD.operation_id
        AND NEW.tenant_id = OLD.tenant_id
        AND NEW.state = OLD.state
        AND NEW.range_start = OLD.range_start
        AND NEW.range_end = OLD.range_end
        AND NEW.supersedes_operation_id IS NOT DISTINCT FROM OLD.supersedes_operation_id
        AND NEW.object_key IS NOT DISTINCT FROM OLD.object_key
        AND NEW.row_count IS NOT DISTINCT FROM OLD.row_count
        AND NEW.sha256 IS NOT DISTINCT FROM OLD.sha256
        AND NEW.schema_version IS NOT DISTINCT FROM OLD.schema_version
        AND NEW.snapshot_id IS NOT DISTINCT FROM OLD.snapshot_id
        AND NEW.wal_lsn IS NOT DISTINCT FROM OLD.wal_lsn
        AND NEW.error_message IS NOT DISTINCT FROM OLD.error_message
        AND NEW.recorded_at = OLD.recorded_at THEN
       RETURN NEW;
     END IF;
     IF TG_OP = 'DELETE'
        AND current_setting('app.telemetry_archive_erasure_operation_id', true)
            ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
       RETURN OLD;
     END IF;
     RAISE EXCEPTION 'telemetry_archive_events is append-only';
   END;
   $$`,
  `CREATE OR REPLACE FUNCTION sensor.append_telemetry_archive_event_v2(
     p_operation_id uuid,
     p_tenant_id uuid,
     p_state text,
     p_range_start timestamptz,
     p_range_end timestamptz,
     p_supersedes_operation_id uuid DEFAULT NULL,
     p_object_key text DEFAULT NULL,
     p_row_count bigint DEFAULT NULL,
     p_sha256 text DEFAULT NULL,
     p_schema_version integer DEFAULT NULL,
     p_snapshot_id text DEFAULT NULL,
     p_wal_lsn text DEFAULT NULL,
     p_error_message text DEFAULT NULL,
     p_bucket_name text DEFAULT NULL,
     p_object_version_id text DEFAULT NULL,
     p_archive_format text DEFAULT NULL,
     p_min_time timestamptz DEFAULT NULL,
     p_max_time timestamptz DEFAULT NULL
   ) RETURNS uuid
   LANGUAGE plpgsql
   SECURITY DEFINER
   SET search_path = pg_catalog, sensor
   AS $$
   DECLARE
     v_event_id uuid;
     v_exported sensor.telemetry_archive_events%ROWTYPE;
   BEGIN
     IF p_state <> 'FAILED' AND EXISTS (
       SELECT 1 FROM sensor.telemetry_archive_cancellations
        WHERE tenant_id = p_tenant_id
     ) THEN
       RAISE EXCEPTION 'telemetry archive operation is cancelled for erased tenant';
     END IF;
     IF p_state IN ('EXPORTED', 'VERIFIED') AND (
       p_bucket_name IS NULL OR p_object_version_id IS NULL
       OR p_archive_format IS DISTINCT FROM 'PARQUET'
       OR p_object_key IS NULL OR p_row_count IS NULL OR p_row_count < 0
       OR p_sha256 IS NULL OR p_sha256 !~ '^[0-9a-f]{64}$'
       OR p_schema_version IS NULL OR p_schema_version < 1
       OR p_snapshot_id IS NULL OR p_wal_lsn IS NULL
       OR (p_row_count > 0 AND (p_min_time IS NULL OR p_max_time IS NULL))
       OR (p_row_count = 0 AND (p_min_time IS NOT NULL OR p_max_time IS NOT NULL))
       OR p_min_time > p_max_time
     ) THEN
       RAISE EXCEPTION 'EXPORTED and VERIFIED require a complete version-bound Parquet manifest';
     END IF;
     IF p_bucket_name IS NOT NULL AND (
       p_bucket_name !~ '^aqua-telemetry-[0-9a-f]{32}$'
       OR p_bucket_name IS DISTINCT FROM
          'aqua-telemetry-' || replace(p_tenant_id::text, '-', '')
     ) THEN
       RAISE EXCEPTION 'archive bucket name is not tenant-isolated';
     END IF;

     IF p_state = 'VERIFIED' THEN
       SELECT * INTO v_exported
         FROM sensor.telemetry_archive_events
        WHERE operation_id = p_operation_id AND state = 'EXPORTED';
       IF NOT FOUND OR v_exported.tenant_id IS DISTINCT FROM p_tenant_id
          OR v_exported.range_start IS DISTINCT FROM p_range_start
          OR v_exported.range_end IS DISTINCT FROM p_range_end
          OR v_exported.object_key IS DISTINCT FROM p_object_key
          OR v_exported.row_count IS DISTINCT FROM p_row_count
          OR v_exported.sha256 IS DISTINCT FROM p_sha256
          OR v_exported.schema_version IS DISTINCT FROM p_schema_version
          OR v_exported.snapshot_id IS DISTINCT FROM p_snapshot_id
          OR v_exported.wal_lsn IS DISTINCT FROM p_wal_lsn
          OR v_exported.bucket_name IS DISTINCT FROM p_bucket_name
          OR v_exported.object_version_id IS DISTINCT FROM p_object_version_id
          OR v_exported.archive_format IS DISTINCT FROM p_archive_format
          OR v_exported.min_time IS DISTINCT FROM p_min_time
          OR v_exported.max_time IS DISTINCT FROM p_max_time THEN
         RAISE EXCEPTION 'VERIFIED manifest must exactly match EXPORTED manifest';
       END IF;
     END IF;

     v_event_id := sensor.append_telemetry_archive_event_state_machine(
       p_operation_id, p_tenant_id, p_state, p_range_start, p_range_end,
       p_supersedes_operation_id, p_object_key, p_row_count, p_sha256,
       p_schema_version, p_snapshot_id, p_wal_lsn, p_error_message
     );
     PERFORM set_config('app.telemetry_archive_internal_event_id', v_event_id::text, true);
     UPDATE sensor.telemetry_archive_events
        SET bucket_name = p_bucket_name,
            object_version_id = p_object_version_id,
            archive_format = p_archive_format,
            min_time = p_min_time,
            max_time = p_max_time
      WHERE event_id = v_event_id;
     RETURN v_event_id;
   END;
   $$`,
  `REVOKE ALL ON FUNCTION sensor.append_telemetry_archive_event_v2(
     uuid, uuid, text, timestamptz, timestamptz, uuid, text, bigint, text,
     integer, text, text, text, text, text, text, timestamptz, timestamptz
   ) FROM PUBLIC`,
  `GRANT EXECUTE ON FUNCTION sensor.append_telemetry_archive_event_v2(
     uuid, uuid, text, timestamptz, timestamptz, uuid, text, bigint, text,
     integer, text, text, text, text, text, text, timestamptz, timestamptz
   ) TO sensor_service`,
  `CREATE OR REPLACE FUNCTION sensor.assert_telemetry_archive_tenant_active(p_tenant_id uuid)
   RETURNS void
   LANGUAGE plpgsql
   SECURITY DEFINER
   SET search_path = pg_catalog, sensor
   AS $$
   BEGIN
     IF EXISTS (
       SELECT 1 FROM sensor.telemetry_archive_cancellations WHERE tenant_id = p_tenant_id
     ) OR EXISTS (
       SELECT 1 FROM sensor.tenant_erasure_target_proofs WHERE "tenantId" = p_tenant_id
     ) THEN
       RAISE EXCEPTION 'telemetry archive operation is cancelled for erased tenant';
     END IF;
   END;
   $$`,
  `REVOKE ALL ON FUNCTION sensor.assert_telemetry_archive_tenant_active(uuid) FROM PUBLIC`,
  `GRANT EXECUTE ON FUNCTION sensor.assert_telemetry_archive_tenant_active(uuid)
   TO sensor_service`,
  `CREATE OR REPLACE FUNCTION sensor.cancel_telemetry_archive_tenant(
     p_tenant_id uuid,
     p_erasure_operation_id uuid
   ) RETURNS void
   LANGUAGE plpgsql
   SECURITY DEFINER
   SET search_path = pg_catalog, sensor
   AS $$
   BEGIN
     PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant_id::text, 0));
     INSERT INTO sensor.telemetry_archive_cancellations (
       tenant_id, erasure_operation_id
     ) VALUES (p_tenant_id, p_erasure_operation_id)
     ON CONFLICT (tenant_id) DO NOTHING;
   END;
   $$`,
  `REVOKE ALL ON FUNCTION sensor.cancel_telemetry_archive_tenant(uuid, uuid) FROM PUBLIC`,
  `GRANT EXECUTE ON FUNCTION sensor.cancel_telemetry_archive_tenant(uuid, uuid)
   TO sensor_service`,
  `CREATE OR REPLACE FUNCTION sensor.record_telemetry_archive_presign(
     p_tenant_id uuid,
     p_operation_id uuid,
     p_url_sha256 text,
     p_expires_at timestamptz
   ) RETURNS void
   LANGUAGE plpgsql
   SECURITY DEFINER
   SET search_path = pg_catalog, sensor
   AS $$
   BEGIN
     IF p_url_sha256 !~ '^[0-9a-f]{64}$'
        OR p_expires_at <= clock_timestamp()
        OR p_expires_at > clock_timestamp() + interval '15 minutes 5 seconds' THEN
       RAISE EXCEPTION 'invalid telemetry archive presign evidence';
     END IF;
     PERFORM sensor.assert_telemetry_archive_tenant_active(p_tenant_id);
     INSERT INTO sensor.telemetry_archive_presigns (
       tenant_id, operation_id, url_sha256, expires_at
     ) VALUES (p_tenant_id, p_operation_id, p_url_sha256, p_expires_at);
   END;
   $$`,
  `REVOKE ALL ON FUNCTION sensor.record_telemetry_archive_presign(
     uuid, uuid, text, timestamptz
   ) FROM PUBLIC`,
  `GRANT EXECUTE ON FUNCTION sensor.record_telemetry_archive_presign(
     uuid, uuid, text, timestamptz
   ) TO sensor_service`,
  `CREATE OR REPLACE FUNCTION sensor.revoke_telemetry_archive_presigns(p_tenant_id uuid)
   RETURNS bigint
   LANGUAGE plpgsql
   SECURITY DEFINER
   SET search_path = pg_catalog, sensor
   AS $$
   DECLARE
     v_count bigint;
   BEGIN
     UPDATE sensor.telemetry_archive_presigns
        SET revoked_at = clock_timestamp()
      WHERE tenant_id = p_tenant_id AND revoked_at IS NULL;
     GET DIAGNOSTICS v_count = ROW_COUNT;
     RETURN v_count;
   END;
   $$`,
  `REVOKE ALL ON FUNCTION sensor.revoke_telemetry_archive_presigns(uuid) FROM PUBLIC`,
  `GRANT EXECUTE ON FUNCTION sensor.revoke_telemetry_archive_presigns(uuid)
   TO sensor_service`,
  `DO $$
   BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'telemetry_archive_erasure') THEN
       CREATE ROLE telemetry_archive_erasure NOLOGIN;
     END IF;
     IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'telemetry_archive_restore') THEN
       CREATE ROLE telemetry_archive_restore NOLOGIN;
     END IF;
   END
   $$`,
  `CREATE OR REPLACE FUNCTION sensor.create_telemetry_restore_scratch(
     p_operation_id uuid,
     p_tenant_id uuid,
     p_object_sha256 text,
     p_expires_at timestamptz
   ) RETURNS text
   LANGUAGE plpgsql
   SECURITY DEFINER
   SET search_path = pg_catalog, sensor
   AS $$
   DECLARE
     v_schema text := 'restore_' || replace(p_operation_id::text, '-', '');
   BEGIN
     IF p_object_sha256 !~ '^[0-9a-f]{64}$'
        OR p_expires_at <= clock_timestamp()
        OR p_expires_at > clock_timestamp() + interval '24 hours' THEN
       RAISE EXCEPTION 'invalid telemetry restore scratch request';
     END IF;
     IF v_schema !~ '^restore_[0-9a-f]{32}$' THEN
       RAISE EXCEPTION 'invalid telemetry restore scratch schema';
     END IF;

     EXECUTE format('CREATE SCHEMA %I', v_schema);
     EXECUTE format(
       'CREATE TABLE %I.restore_metadata (
          operation_id uuid PRIMARY KEY,
          tenant_id uuid NOT NULL,
          object_sha256 character(64) NOT NULL,
          expires_at timestamptz NOT NULL
        )', v_schema
     );
     EXECUTE format(
       'CREATE TABLE %I.sensor_metrics (
          time timestamptz NOT NULL,
          sensor_id uuid NOT NULL,
          channel_id uuid NOT NULL,
          tenant_id uuid NOT NULL,
          raw_value double precision NOT NULL,
          value double precision NOT NULL,
          quality_code smallint NOT NULL,
          quality_bits smallint NOT NULL,
          source_event_id varchar(160),
          source_timestamp timestamptz,
          source_sequence bigint,
          site_id uuid,
          department_id uuid,
          system_id uuid,
          equipment_id uuid,
          tank_id uuid,
          pond_id uuid,
          farm_id uuid,
          source_protocol varchar(20),
          ingestion_latency_ms integer,
          batch_id uuid,
          PRIMARY KEY (time, sensor_id, channel_id),
          CHECK (tenant_id = %L::uuid)
        )', v_schema, p_tenant_id::text
     );
     EXECUTE format(
       'INSERT INTO %I.restore_metadata (
          operation_id, tenant_id, object_sha256, expires_at
        ) VALUES ($1, $2, $3, $4)', v_schema
     ) USING p_operation_id, p_tenant_id, p_object_sha256, p_expires_at;
     EXECUTE format('GRANT USAGE ON SCHEMA %I TO telemetry_archive_restore', v_schema);
    EXECUTE format(
      'GRANT SELECT ON %I.restore_metadata TO telemetry_archive_restore',
      v_schema
    );
    EXECUTE format(
      'GRANT SELECT, INSERT ON %I.sensor_metrics TO telemetry_archive_restore',
      v_schema
    );
     RETURN v_schema;
   END;
   $$`,
  `REVOKE ALL ON FUNCTION sensor.create_telemetry_restore_scratch(
     uuid, uuid, text, timestamptz
   ) FROM PUBLIC, sensor_service`,
  `GRANT USAGE ON SCHEMA sensor TO telemetry_archive_restore`,
  `GRANT EXECUTE ON FUNCTION sensor.create_telemetry_restore_scratch(
     uuid, uuid, text, timestamptz
   ) TO telemetry_archive_restore`,
  `CREATE OR REPLACE FUNCTION sensor.drop_expired_telemetry_restore_scratch()
   RETURNS integer
   LANGUAGE plpgsql
   SECURITY DEFINER
   SET search_path = pg_catalog, sensor
   AS $$
   DECLARE
     v_schema record;
     v_expires_at timestamptz;
     v_metadata_count bigint;
     v_dropped integer := 0;
   BEGIN
     FOR v_schema IN
       SELECT nspname
         FROM pg_namespace
        WHERE nspname ~ '^restore_[0-9a-f]{32}$'
     LOOP
       IF to_regclass(format('%I.restore_metadata', v_schema.nspname)) IS NULL THEN
         RAISE EXCEPTION 'restore scratch schema % has no TTL metadata', v_schema.nspname;
       END IF;
      EXECUTE format(
        'SELECT count(*), min(expires_at) FROM %I.restore_metadata',
        v_schema.nspname
      ) INTO v_metadata_count, v_expires_at;
      IF v_metadata_count <> 1 OR v_expires_at IS NULL THEN
         RAISE EXCEPTION 'restore scratch schema % has invalid TTL metadata', v_schema.nspname;
       END IF;
       IF v_expires_at <= clock_timestamp() THEN
         EXECUTE format('DROP SCHEMA %I CASCADE', v_schema.nspname);
         v_dropped := v_dropped + 1;
       END IF;
     END LOOP;
     RETURN v_dropped;
   END;
   $$`,
  `REVOKE ALL ON FUNCTION sensor.drop_expired_telemetry_restore_scratch()
   FROM PUBLIC, sensor_service`,
  `GRANT EXECUTE ON FUNCTION sensor.drop_expired_telemetry_restore_scratch()
   TO telemetry_archive_restore`,
  `CREATE OR REPLACE FUNCTION sensor.erase_telemetry_archive_tenant_links(
     p_tenant_id uuid,
     p_erasure_operation_id uuid
   ) RETURNS TABLE(deleted_event_count bigint, evidence_sha256 text)
   LANGUAGE plpgsql
   SECURITY DEFINER
   SET search_path = pg_catalog, sensor
   AS $$
   DECLARE
     v_count bigint;
     v_evidence_sha256 text;
     v_has_hold boolean;
   BEGIN
    IF to_regclass('compliance.legal_holds') IS NULL THEN
       RAISE EXCEPTION 'authoritative legal-hold registry is unavailable';
     END IF;

     PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant_id::text, 0));
    SELECT EXISTS (
      SELECT 1 FROM compliance.legal_holds
       WHERE "tenantId" = p_tenant_id
         AND "scope" = 'tenant'
         AND "resourceId" IS NULL
         AND "releasedAt" IS NULL
    ) INTO v_has_hold;
     IF v_has_hold THEN
       RAISE EXCEPTION 'tenant is under legal hold';
     END IF;

     SELECT count(*),
            encode(public.digest(
              p_tenant_id::text || ':' || p_erasure_operation_id::text || ':' || count(*)::text,
              'sha256'
            ), 'hex')
       INTO v_count, v_evidence_sha256
       FROM sensor.telemetry_archive_events
      WHERE tenant_id = p_tenant_id;

     PERFORM set_config(
       'app.telemetry_archive_erasure_operation_id',
       p_erasure_operation_id::text,
       true
     );
     DELETE FROM sensor.telemetry_archive_events WHERE tenant_id = p_tenant_id;
     DELETE FROM sensor.telemetry_archive_presigns WHERE tenant_id = p_tenant_id;
     RETURN QUERY SELECT v_count, v_evidence_sha256;
   END;
   $$`,
  `REVOKE ALL ON FUNCTION sensor.erase_telemetry_archive_tenant_links(uuid, uuid)
   FROM PUBLIC, sensor_service`,
  `GRANT USAGE ON SCHEMA sensor TO telemetry_archive_erasure`,
  `GRANT EXECUTE ON FUNCTION sensor.erase_telemetry_archive_tenant_links(uuid, uuid)
   TO telemetry_archive_erasure`,
] as const;

export class TelemetryArchiveErasure1816000000003 implements MigrationInterface {
  readonly name = 'TelemetryArchiveErasure1816000000003';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const statement of TELEMETRY_ARCHIVE_ERASURE_UP_STATEMENTS) {
      await queryRunner.query(statement);
    }
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    throw new Error(
      'Telemetry archive erasure is forward-only; rollback must not resurrect tenant links',
    );
  }
}
