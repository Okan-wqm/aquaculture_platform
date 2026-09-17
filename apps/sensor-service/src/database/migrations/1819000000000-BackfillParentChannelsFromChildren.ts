import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Backfill parent-side data channels from child sensors (SENSOR-HIGH-117).
 *
 * # Why
 *
 * The MQTT listener resolves a message topic to the PARENT sensor — the row
 * that owns `protocol_configuration.topic` — and then reads
 * `sensor_data_channels` of that sensor only. `registerParentWithChildren`
 * used to persist each child's `data_path` on the child `sensors` row and
 * never created a channel on the parent, so every wizard-registered MQTT
 * device ingested zero rows, silently. The registration path now derives
 * parent channels from children; this migration carries the same derivation
 * over devices that were registered before the fix.
 *
 * # What it does
 *
 * For each child sensor with a `data_path` whose parent has no channel with
 * the sanitized key, INSERT one parent channel. `channel_key` mirrors the
 * application-side `sanitizeChannelKey` (lowercase, non [a-z0-9_] folded to
 * `_`, trimmed, ≤100); two children that sanitize to the same key are deduped
 * by the `ON CONFLICT (tenant_id, sensor_id, channel_key) DO NOTHING` —
 * first writer wins, exactly like the runtime path's suffix uniquification
 * but without a stable order guarantee, which is acceptable for a backfill.
 *
 * # Tenant routing
 *
 * The migration runner executes this file once per tenant schema with the
 * search_path pinned to that schema, so `sensors`/`sensor_data_channels`
 * below resolve to the schema being migrated. The `current_schema()` guard
 * keeps the `sensor` source-schema pass a no-op.
 *
 * # Reversibility
 *
 * `down` is intentionally a no-op: backfilled rows are indistinguishable
 * from operator-created channels (both `discovery_source = 'manual'`), and
 * deleting channel config would also delete thresholds/calibration
 * operators may have layered on since. The INSERT is idempotent
 * (`ON CONFLICT DO NOTHING`), so re-runs are free.
 */
export class BackfillParentChannelsFromChildren1819000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    const present: Array<{ ready: boolean }> = await queryRunner.query(
      `SELECT to_regclass('sensors') IS NOT NULL
              AND to_regclass('sensor_data_channels') IS NOT NULL AS ready`,
    );
    if (present[0]?.ready !== true) {
      return;
    }

    // Only the per-tenant-schema passes do work; the source `sensor` schema
    // pass has no parent/child rows and would fail the guard anyway.
    const isTenantSchema: Array<{ is_tenant: boolean }> = await queryRunner.query(
      `SELECT left(current_schema(), 7) = 'tenant_' AS is_tenant`,
    );
    if (isTenantSchema[0]?.is_tenant !== true) {
      return;
    }

    // One row per (parent, child-with-data_path) that does not already have a
    // parent channel for the sanitized key. The lateral count keeps
    // display_order stable by creation order of the children.
    await queryRunner.query(`
      INSERT INTO "sensor_data_channels"
        ("id", "sensor_id", "tenant_id", "channel_key", "display_label", "data_type",
         "unit", "dataPath", "minValue", "maxValue",
         "calibration_enabled", "calibration_multiplier", "calibration_offset",
         "alertThresholds", "displaySettings",
         "is_enabled", "display_order", "discovery_source", "created_at", "updated_at")
      SELECT gen_random_uuid(),
             p."id",
             p."tenant_id",
             coalesce(
               nullif(
                 left(
                   regexp_replace(
                     regexp_replace(lower(c."data_path"), '[^a-z0-9_]+', '_', 'g'),
                     '^_+|_+$', '', 'g'
                   ), 100
                 ), ''
               ), 'channel'
             )                                   AS channel_key,
             c."name"                            AS display_label,
             'number'                            AS data_type,
             c."unit"                            AS unit,
             c."data_path"                       AS "dataPath",
             c."min_value"                       AS "minValue",
             c."max_value"                       AS "maxValue",
             coalesce(c."calibration_enabled", false),
             coalesce(c."calibration_multiplier", 1),
             coalesce(c."calibration_offset", 0),
             c."alert_thresholds"                AS "alertThresholds",
             coalesce(
               c."display_settings" || jsonb_build_object('showOnDashboard', true),
               jsonb_build_object('showOnDashboard', true)
             )                                   AS "displaySettings",
             true                                AS is_enabled,
             row_number() OVER (PARTITION BY p."id" ORDER BY c."created_at", c."id") - 1 AS display_order,
             'manual'                            AS discovery_source,
             now(), now()
        FROM "sensors" p
        JOIN "sensors" c
          ON c."parent_id" = p."id"
         AND c."sensor_role" = 'child'
         AND c."data_path" IS NOT NULL
       WHERE p."is_parent_device" = true
       ORDER BY p."id", c."created_at"
      ON CONFLICT ("tenant_id", "sensor_id", "channel_key") DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Intentional no-op — see the reversibility note in the header.
    void queryRunner;
  }
}
