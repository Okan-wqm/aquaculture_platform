import { MigrationInterface, QueryRunner } from 'typeorm';

export class EventStoreTenantScopedSequenceAndProjectionInbox1800200000000
  implements MigrationInterface
{
  name = 'EventStoreTenantScopedSequenceAndProjectionInbox1800200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE SEQUENCE IF NOT EXISTS "event_store"."stored_events_global_position_seq" AS BIGINT START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1`,
    );
    await queryRunner.query(
      `SELECT setval(
         '"event_store"."stored_events_global_position_seq"',
         COALESCE((SELECT MAX("globalPosition") FROM "event_store"."stored_events"), 1),
         EXISTS (SELECT 1 FROM "event_store"."stored_events")
       )`,
    );

    await queryRunner.query(
      `DROP INDEX IF EXISTS "event_store"."IDX_aebc68416a5ae504289cb6893d"`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_stored_events_tenant_aggregate_type_id_version"
         ON "event_store"."stored_events" ("tenantId", "aggregateType", "aggregateId", "version")`,
    );

    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "event_store"."projection_inbox" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "tenantId" uuid NOT NULL,
        "projectionName" character varying(255) NOT NULL,
        "eventId" uuid NOT NULL,
        "globalPosition" bigint NOT NULL,
        "processedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_projection_inbox" PRIMARY KEY ("id")
      )`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_projection_inbox_tenant_projection_event"
         ON "event_store"."projection_inbox" ("tenantId", "projectionName", "eventId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_projection_inbox_tenant_projection_position"
         ON "event_store"."projection_inbox" ("tenantId", "projectionName", "globalPosition")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "event_store"."IDX_projection_inbox_tenant_projection_position"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "event_store"."IDX_projection_inbox_tenant_projection_event"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "event_store"."projection_inbox"`);

    await queryRunner.query(
      `DROP INDEX IF EXISTS "event_store"."IDX_stored_events_tenant_aggregate_type_id_version"`,
    );
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM (
            SELECT "aggregateType", "aggregateId", "version", COUNT(*) AS count
            FROM "event_store"."stored_events"
            GROUP BY "aggregateType", "aggregateId", "version"
            HAVING COUNT(*) > 1
          ) duplicate_aggregate_versions
        ) THEN
          CREATE UNIQUE INDEX IF NOT EXISTS "IDX_aebc68416a5ae504289cb6893d"
            ON "event_store"."stored_events" ("aggregateType", "aggregateId", "version");
        END IF;
      END $$;
    `);
    await queryRunner.query(
      `DROP SEQUENCE IF EXISTS "event_store"."stored_events_global_position_seq"`,
    );
  }
}
