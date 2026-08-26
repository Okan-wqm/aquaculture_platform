import { MigrationInterface, QueryRunner } from 'typeorm';

export const TELEMETRY_ARCHIVE_UP_STATEMENTS = [
  `CREATE TABLE "sensor"."telemetry_archive_events" (
     "event_id" uuid NOT NULL DEFAULT uuid_generate_v4(),
     "operation_id" uuid NOT NULL,
     "tenant_id" uuid NOT NULL,
     "state" character varying(20) NOT NULL,
     "range_start" TIMESTAMP WITH TIME ZONE NOT NULL,
     "range_end" TIMESTAMP WITH TIME ZONE NOT NULL,
     "supersedes_operation_id" uuid,
     "object_key" text,
     "row_count" bigint,
     "sha256" character(64),
     "schema_version" integer,
     "snapshot_id" text,
     "wal_lsn" text,
     "error_message" text,
     "recorded_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
     CONSTRAINT "UQ_telemetry_archive_operation_state" UNIQUE ("operation_id", "state"),
     CONSTRAINT "CHK_telemetry_archive_sha256"
       CHECK ("sha256" IS NULL OR "sha256" ~ '^[0-9a-f]{64}$'),
     CONSTRAINT "CHK_telemetry_archive_range" CHECK ("range_start" < "range_end"),
     CONSTRAINT "CHK_telemetry_archive_state"
       CHECK ("state" IN ('EXPORT_STARTED', 'EXPORTED', 'VERIFIED', 'DROPPED', 'FAILED')),
     CONSTRAINT "PK_0f0b191976c56400d17f02e6eac" PRIMARY KEY ("event_id")
   )`,
  `CREATE INDEX "IDX_telemetry_archive_tenant_range"
     ON "sensor"."telemetry_archive_events" ("tenant_id", "range_start", "range_end")`,
  `CREATE OR REPLACE FUNCTION "sensor".telemetry_archive_events_immutable()
   RETURNS trigger
   LANGUAGE plpgsql
   SET search_path = pg_catalog, sensor
   AS $$
   BEGIN
     RAISE EXCEPTION 'telemetry_archive_events is append-only';
   END;
   $$`,
  `CREATE TRIGGER telemetry_archive_events_immutable
   BEFORE UPDATE OR DELETE ON "sensor"."telemetry_archive_events"
   FOR EACH ROW EXECUTE FUNCTION "sensor".telemetry_archive_events_immutable()`,
  `CREATE OR REPLACE FUNCTION "sensor".append_telemetry_archive_event(
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
     p_error_message text DEFAULT NULL
   ) RETURNS uuid
   LANGUAGE plpgsql
   SECURITY DEFINER
   SET search_path = pg_catalog, sensor
   AS $$
   DECLARE
     v_event_id uuid := public.uuid_generate_v4();
     v_previous_state text;
     v_superseded_state text;
     v_superseded_tenant uuid;
     v_superseded_start timestamptz;
     v_superseded_end timestamptz;
   BEGIN
     IF p_range_start >= p_range_end THEN
       RAISE EXCEPTION 'archive range_start must precede range_end';
     END IF;

     PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant_id::text, 0));

     SELECT state
       INTO v_previous_state
       FROM sensor.telemetry_archive_events
      WHERE operation_id = p_operation_id
      ORDER BY recorded_at DESC, event_id DESC
      LIMIT 1;

     IF FOUND AND EXISTS (
       SELECT 1
         FROM sensor.telemetry_archive_events
        WHERE operation_id = p_operation_id
          AND (tenant_id <> p_tenant_id OR range_start <> p_range_start OR range_end <> p_range_end)
     ) THEN
       RAISE EXCEPTION 'operation tenant and range are immutable';
     END IF;

     IF v_previous_state IS NULL THEN
       IF p_state <> 'EXPORT_STARTED' THEN
         RAISE EXCEPTION 'new archive operation must begin with EXPORT_STARTED';
       END IF;

       IF p_supersedes_operation_id IS NOT NULL THEN
         SELECT state, tenant_id, range_start, range_end
           INTO v_superseded_state, v_superseded_tenant, v_superseded_start, v_superseded_end
           FROM sensor.telemetry_archive_events
          WHERE operation_id = p_supersedes_operation_id
          ORDER BY recorded_at DESC, event_id DESC
          LIMIT 1;
         IF v_superseded_state IS DISTINCT FROM 'FAILED' THEN
           RAISE EXCEPTION 'superseded operation must be FAILED';
         END IF;
         IF v_superseded_tenant IS DISTINCT FROM p_tenant_id
            OR v_superseded_start IS DISTINCT FROM p_range_start
            OR v_superseded_end IS DISTINCT FROM p_range_end THEN
           RAISE EXCEPTION 'retry must preserve superseded tenant and range';
         END IF;
       END IF;

       IF EXISTS (
         SELECT 1
           FROM (
             SELECT DISTINCT ON (operation_id) operation_id, state
               FROM sensor.telemetry_archive_events
              WHERE tenant_id = p_tenant_id
                AND operation_id <> p_operation_id
                AND range_start < p_range_end
                AND range_end > p_range_start
              ORDER BY operation_id, recorded_at DESC, event_id DESC
           ) latest
          WHERE latest.state NOT IN ('FAILED', 'DROPPED')
       ) THEN
         RAISE EXCEPTION 'overlapping archive range is already active for tenant';
       END IF;
     ELSE
       IF v_previous_state = 'FAILED' THEN
         RAISE EXCEPTION 'cannot append to terminal FAILED operation';
       END IF;
       IF NOT (
         (v_previous_state = 'EXPORT_STARTED' AND p_state = 'EXPORTED')
         OR (v_previous_state = 'EXPORTED' AND p_state = 'VERIFIED')
         OR (v_previous_state = 'VERIFIED' AND p_state = 'DROPPED')
         OR (v_previous_state IN ('EXPORT_STARTED', 'EXPORTED', 'VERIFIED') AND p_state = 'FAILED')
       ) THEN
         RAISE EXCEPTION 'invalid telemetry archive lifecycle transition % -> %',
           v_previous_state, p_state;
       END IF;
     END IF;

     IF p_state IN ('EXPORTED', 'VERIFIED') AND (
       p_object_key IS NULL OR p_row_count IS NULL OR p_sha256 IS NULL
       OR p_schema_version IS NULL OR p_snapshot_id IS NULL OR p_wal_lsn IS NULL
     ) THEN
       RAISE EXCEPTION 'exported and verified events require a complete manifest';
     END IF;
     IF p_state = 'FAILED' AND p_error_message IS NULL THEN
       RAISE EXCEPTION 'FAILED event requires error_message';
     END IF;
     IF p_wal_lsn IS NOT NULL THEN
       PERFORM p_wal_lsn::pg_lsn;
     END IF;
     IF p_state = 'DROPPED' AND (
       current_setting('app.telemetry_retention_enabled', true) IS DISTINCT FROM 'true'
       OR current_setting('app.legal_001_approved', true) IS DISTINCT FROM 'true'
     ) THEN
       RAISE EXCEPTION 'raw telemetry drop disabled pending LEGAL-001';
     END IF;

     INSERT INTO sensor.telemetry_archive_events (
       event_id, operation_id, tenant_id, state, range_start, range_end,
       supersedes_operation_id, object_key, row_count, sha256, schema_version,
       snapshot_id, wal_lsn, error_message
     ) VALUES (
       v_event_id, p_operation_id, p_tenant_id, p_state, p_range_start, p_range_end,
       p_supersedes_operation_id, p_object_key, p_row_count, p_sha256,
       p_schema_version, p_snapshot_id, p_wal_lsn, p_error_message
     );
     RETURN v_event_id;
   END;
   $$`,
  `REVOKE INSERT, UPDATE, DELETE ON "sensor"."telemetry_archive_events" FROM PUBLIC`,
  `REVOKE INSERT, UPDATE, DELETE ON "sensor"."telemetry_archive_events" FROM sensor_service`,
  `GRANT SELECT ON "sensor"."telemetry_archive_events" TO sensor_service`,
  `REVOKE ALL ON FUNCTION "sensor".append_telemetry_archive_event(
     uuid, uuid, text, timestamptz, timestamptz, uuid, text, bigint, text,
     integer, text, text, text
   ) FROM PUBLIC`,
  `GRANT EXECUTE ON FUNCTION "sensor".append_telemetry_archive_event(
     uuid, uuid, text, timestamptz, timestamptz, uuid, text, bigint, text,
     integer, text, text, text
   ) TO sensor_service`,
] as const;

export class TelemetryArchiveLifecycle1816000000002 implements MigrationInterface {
  readonly name = 'TelemetryArchiveLifecycle1816000000002';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const statement of TELEMETRY_ARCHIVE_UP_STATEMENTS) {
      await queryRunner.query(statement);
    }
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    throw new Error(
      'Telemetry archive lifecycle ledger is forward-only; rollback must preserve archive evidence',
    );
  }
}
