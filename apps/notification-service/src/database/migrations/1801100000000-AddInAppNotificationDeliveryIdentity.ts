import { SourceOnlyMigration } from '@aquaculture/backend-common/database';
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * FARM-LOW-282: persistent idempotency authority for durable in-app delivery.
 *
 * Existing ad-hoc notification rows remain valid with a null delivery_id.
 * Durable callers supply a stable identity and converge through the partial
 * unique index, including retries and concurrent consumers.
 */
@SourceOnlyMigration({
  reason:
    'notification_logs is platform-level delivery infrastructure in the notification source schema',
})
export class AddInAppNotificationDeliveryIdentity1801100000000 implements MigrationInterface {
  name = 'AddInAppNotificationDeliveryIdentity1801100000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "notification"."notification_logs"
        ADD COLUMN IF NOT EXISTS "delivery_id" varchar(255)
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_notification_logs_in_app_delivery"
        ON "notification"."notification_logs" ("tenant_id", "recipient", "delivery_id")
        WHERE "channel" = 'in_app' AND "delivery_id" IS NOT NULL
    `);
  }

  async postCondition(queryRunner: QueryRunner): Promise<boolean> {
    const rows: Array<{ ready: boolean }> = await queryRunner.query(`
      WITH column_contract AS (
        SELECT data_type = 'character varying'
               AND udt_schema = 'pg_catalog'
               AND udt_name = 'varchar'
               AND character_maximum_length = 255
               AND is_nullable = 'YES'
               AND column_default IS NULL
               AND is_identity = 'NO'
               AND is_generated = 'NEVER' AS ready
          FROM information_schema.columns
         WHERE table_schema = 'notification'
           AND table_name = 'notification_logs'
           AND column_name = 'delivery_id'
      ),
      index_contract AS (
        SELECT access_method.amname = 'btree'
               AND index_catalog.indisunique
               AND index_catalog.indisvalid
               AND index_catalog.indisready
               AND NOT index_catalog.indisprimary
               AND NOT index_catalog.indisexclusion
               AND NOT index_catalog.indnullsnotdistinct
               AND index_catalog.indnkeyatts = 3
               AND index_catalog.indnatts = 3
               AND index_catalog.indexprs IS NULL
               AND index_catalog.indpred IS NOT NULL
               AND (
                 SELECT array_agg(attribute.attname::text ORDER BY key.ordinality)
                   FROM unnest(index_catalog.indkey::smallint[]) WITH ORDINALITY
                     AS key(attnum, ordinality)
                   JOIN pg_catalog.pg_attribute attribute
                     ON attribute.attrelid = index_catalog.indrelid
                    AND attribute.attnum = key.attnum
                  WHERE key.ordinality <= index_catalog.indnkeyatts
               ) = ARRAY['tenant_id', 'recipient', 'delivery_id']
               AND (
                 SELECT array_agg(option.value::integer ORDER BY option.ordinality)
                   FROM unnest(index_catalog.indoption::smallint[]) WITH ORDINALITY
                     AS option(value, ordinality)
               ) = ARRAY[0, 0, 0]
               AND btrim(
                 regexp_replace(
                   replace(
                     replace(
                       replace(
                         replace(
                           lower(
                             pg_catalog.pg_get_expr(
                               index_catalog.indpred,
                               index_catalog.indrelid,
                               false
                             )
                           ),
                           '"',
                           ''
                         ),
                         '::notification.',
                         '::'
                       ),
                       '(',
                       ''
                     ),
                     ')',
                     ''
                   ),
                   '[[:space:]]+',
                   ' ',
                   'g'
                 )
               ) =
                 'channel = ''in_app''::notification_logs_channel_enum and delivery_id is not null'
               AS ready
          FROM pg_catalog.pg_class index_relation
          JOIN pg_catalog.pg_namespace index_namespace
            ON index_namespace.oid = index_relation.relnamespace
          JOIN pg_catalog.pg_index index_catalog
            ON index_catalog.indexrelid = index_relation.oid
          JOIN pg_catalog.pg_class table_relation
            ON table_relation.oid = index_catalog.indrelid
          JOIN pg_catalog.pg_namespace table_namespace
            ON table_namespace.oid = table_relation.relnamespace
          JOIN pg_catalog.pg_am access_method
            ON access_method.oid = index_relation.relam
         WHERE index_namespace.nspname = 'notification'
           AND index_relation.relname = 'uq_notification_logs_in_app_delivery'
           AND table_namespace.nspname = 'notification'
           AND table_relation.relname = 'notification_logs'
      )
      SELECT COALESCE(
               (SELECT count(*) = 1 AND bool_and(ready) FROM column_contract),
               false
             )
             AND COALESCE(
               (SELECT count(*) = 1 AND bool_and(ready) FROM index_contract),
               false
             ) AS ready
    `);
    return rows[0]?.ready === true;
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'DROP INDEX IF EXISTS "notification"."uq_notification_logs_in_app_delivery"',
    );
    await queryRunner.query(`
      ALTER TABLE "notification"."notification_logs"
        DROP COLUMN IF EXISTS "delivery_id"
    `);
  }
}
