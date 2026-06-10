import { MigrationInterface, QueryRunner } from 'typeorm';

export class EventStoreTenantPositionContract1800000001000
  implements MigrationInterface
{
  name = 'EventStoreTenantPositionContract1800000001000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE SEQUENCE IF NOT EXISTS "event_store"."stored_events_global_position_seq" AS bigint START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1`,
    );

    await queryRunner.query(
      `SELECT setval(
        'event_store.stored_events_global_position_seq',
        GREATEST(COALESCE((SELECT MAX("globalPosition") FROM "event_store"."stored_events"), 0), 1),
        COALESCE((SELECT MAX("globalPosition") FROM "event_store"."stored_events"), 0) > 0
      )`,
    );

    await queryRunner.query(
      `ALTER SEQUENCE IF EXISTS "event_store"."stored_events_global_position_seq" OWNED BY "event_store"."stored_events"."globalPosition"`,
    );

    await queryRunner.query(
      `DROP INDEX IF EXISTS "event_store"."IDX_aebc68416a5ae504289cb6893d"`,
    );

    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_stored_events_tenant_aggregate_version" ON "event_store"."stored_events" ("tenantId", "aggregateType", "aggregateId", "version")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "event_store"."UQ_stored_events_tenant_aggregate_version"`,
    );

    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_aebc68416a5ae504289cb6893d" ON "event_store"."stored_events" ("aggregateType", "aggregateId", "version")`,
    );

    await queryRunner.query(
      `ALTER SEQUENCE IF EXISTS "event_store"."stored_events_global_position_seq" OWNED BY NONE`,
    );

    await queryRunner.query(
      `DROP SEQUENCE IF EXISTS "event_store"."stored_events_global_position_seq"`,
    );
  }
}
