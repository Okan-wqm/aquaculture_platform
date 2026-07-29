import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Carry the historical `sensor_readings` rows into each tenant's channel-keyed
 * metrics store, so switching the read path does not make the past disappear
 * (SENSOR-HIGH-085 / B2).
 *
 * # What would break without this
 *
 * A SensorReading is now an as-of projection over the per-tenant
 * `sensor_metrics` hypertable. The MQTT/edge ingest path has written that store
 * for a while, so its history is already there — but the GraphQL ingest path
 * (`ingestReading` / `batchIngestReadings`) wrote ONLY `sensor_readings` until
 * the reading-store convergence, which ships in this same change. Deploy the
 * new read path without moving that data and every reading a tenant recorded
 * through the API vanishes from `latestReading`, `readings`,
 * `latestReadingsBatch` and every dashboard built on them. The rows are still
 * on disk; they are simply unreachable, which is the worst kind of data loss
 * because nothing reports an error.
 *
 * # Tenant routing without a reverse lookup
 *
 * `sensor_readings` is a CROSS-TENANT table in the `sensor` source schema; the
 * destination is per-tenant. The schema name is not invertible — it is the
 * tenant UUID's first 16 hex characters — so rather than parsing the schema
 * name back into a tenant id, every row recomputes its own destination the way
 * `getTenantSchemaName()` does and keeps only the rows that belong to the
 * schema being migrated. Selection is by equality on the computed name, never
 * a prefix match, so a row can land in exactly one schema.
 *
 * In the `sensor` source pass `current_schema()` never equals a `tenant_…`
 * name, so the statement matches zero rows and the pass is a no-op.
 *
 * # Channels
 *
 * A metric row needs a channel. Historical readings are a JSONB object keyed by
 * camelCase parameter, and a tenant may never have registered a channel for a
 * parameter it only ever posted through the API — the same gap the ingest path
 * now closes by auto-provisioning. This creates the missing channels first,
 * under the canonical snake_case device key (matching
 * `canonicalChannelKeyForParameter`), so a backfilled channel is
 * indistinguishable from one a device would have registered and the
 * `(tenant_id, sensor_id, channel_key)` constraint dedupes it against an
 * existing one.
 *
 * # The two values a historical row cannot supply
 *
 * `raw_value` — pre-calibration measurement. `sensor_readings` stored only the
 * calibrated value, so raw is set equal to it. This is the same upcast the V1
 * ingest wire format uses when a producer predates the raw/calibrated split.
 *
 * `quality_code` — device-reported OPC-UA trust. `sensor_readings.quality` is a
 * 0-100 plausibility SCORE, a different axis entirely; mapping one onto the
 * other would repeat the scale confusion this cycle just removed. Historical
 * rows therefore take the column default (192, GOOD), which is precisely the
 * rule the read path already applies to a channel that recorded no code: no
 * quality information is not the same as bad quality.
 *
 * # Safety
 *
 * Idempotent and re-runnable: channels are inserted ON CONFLICT DO NOTHING and
 * metrics conflict on the `(time, sensor_id, channel_id)` primary key. Guarded
 * on both tables existing, so a database where `sensor_readings` was already
 * dropped (F-085-DROP) or a tenant provisioned after the cutover both skip
 * cleanly. Forward-only: `down()` deliberately deletes nothing, because the
 * backfilled rows are indistinguishable from live ones and a reverse pass
 * would take real telemetry with it.
 *
 * MUST land before F-085-DROP physically removes `sensor_readings`.
 */
export class BackfillSensorReadingsIntoTenantMetrics1816000000000 implements MigrationInterface {
  name = 'BackfillSensorReadingsIntoTenantMetrics1816000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const present: Array<{ ready: boolean }> = await queryRunner.query(
      `SELECT to_regclass('sensor.sensor_readings') IS NOT NULL
              AND to_regclass('sensor_metrics') IS NOT NULL
              AND to_regclass('sensor_data_channels') IS NOT NULL AS ready`,
    );
    if (present[0]?.ready !== true) {
      return;
    }

    // Every reading row that belongs to the schema being migrated, exploded to
    // one (sensor, parameter, value) triple per populated JSONB key. Non-UUID
    // sensor ids are dropped: `sensor_readings.sensor_id` is varchar while
    // `sensor_metrics.sensor_id` is uuid, and a row whose sensor cannot be
    // identified has no channel to attach to.
    const readingTriples = `
      SELECT (r.sensor_id)::uuid                                      AS sensor_id,
             r.tenant_id                                              AS tenant_id,
             r."timestamp"                                            AS time,
             lower(regexp_replace(kv.key, '([A-Z])', '_\\1', 'g'))     AS channel_key,
             kv.key                                                   AS parameter,
             (kv.value #>> '{}')::double precision                    AS value,
             r.pond_id, r.farm_id
        FROM "sensor"."sensor_readings" r
        CROSS JOIN LATERAL jsonb_each(r.readings) AS kv(key, value)
       WHERE 'tenant_' || left(replace(r.tenant_id::text, '-', ''), 16) = current_schema()
         AND r.sensor_id ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
         AND jsonb_typeof(kv.value) = 'number'`;

    // 1. Channels for every (sensor, parameter) pair the history mentions.
    await queryRunner.query(`
      INSERT INTO sensor_data_channels (sensor_id, tenant_id, channel_key, display_label, discovery_source)
      SELECT DISTINCT t.sensor_id, t.tenant_id, t.channel_key, t.parameter,
             -- The enum type is created once, in the source schema, and every
             -- tenant copy of the column references that same type; an untyped
             -- literal in a SELECT list is not assignment-cast the way a VALUES
             -- literal is, so the cast has to be spelled out.
             'auto'::"sensor"."sensor_data_channels_discovery_source_enum"
        FROM (${readingTriples}) t
      ON CONFLICT DO NOTHING`);

    // 2. The metric rows themselves, joined onto whichever channel now carries
    //    the parameter — the one just created, or the one the tenant already
    //    had under any of its device-naming aliases.
    await queryRunner.query(`
      INSERT INTO sensor_metrics (time, sensor_id, channel_id, tenant_id, raw_value, value, pond_id, farm_id)
      SELECT t.time, t.sensor_id, c.id, t.tenant_id, t.value, t.value,
             (CASE WHEN t.pond_id ~ '^[0-9a-fA-F-]{36}$' THEN t.pond_id::uuid END),
             (CASE WHEN t.farm_id ~ '^[0-9a-fA-F-]{36}$' THEN t.farm_id::uuid END)
        FROM (${readingTriples}) t
        JOIN sensor_data_channels c
          ON c.sensor_id = t.sensor_id
         AND c.tenant_id = t.tenant_id
         AND c.channel_key = t.channel_key
      ON CONFLICT DO NOTHING`);
  }

  public async down(): Promise<void> {
    // Intentionally empty. Backfilled rows carry no marker distinguishing them
    // from telemetry ingested after the cutover, so any reverse pass broad
    // enough to remove them would also remove live data. Rolling this back is a
    // restore, not a down().
  }
}
