import { MigrationInterface, QueryRunner } from 'typeorm';

export class EventLedgerIdempotencyAndImmutability1800300000000
  implements MigrationInterface
{
  name = 'EventLedgerIdempotencyAndImmutability1800300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        CREATE TYPE "event_store"."append_idempotency_status_enum"
          AS ENUM('started', 'completed');
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "event_store"."append_idempotency" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "tenantId" uuid NOT NULL,
        "producer" character varying(100) NOT NULL,
        "idempotencyKey" character varying(255) NOT NULL,
        "requestHash" char(64) NOT NULL,
        "status" "event_store"."append_idempotency_status_enum" NOT NULL DEFAULT 'started',
        "result" jsonb,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_append_idempotency" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_append_idempotency_tenant_producer_key"
      ON "event_store"."append_idempotency" ("tenantId", "producer", "idempotencyKey")
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "event_store"."ledger_cursors" (
        "name" character varying(64) NOT NULL,
        "nextPosition" bigint NOT NULL,
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_ledger_cursors" PRIMARY KEY ("name")
      )
    `);
    await queryRunner.query(`
      INSERT INTO "event_store"."ledger_cursors" ("name", "nextPosition")
      VALUES ('global', COALESCE((SELECT max("globalPosition") FROM "event_store"."stored_events"), 0))
      ON CONFLICT ("name") DO NOTHING
    `);
    await queryRunner.query(`
      ALTER TABLE "event_store"."stored_events"
      ADD COLUMN IF NOT EXISTS "producer" character varying(100)
    `);
    await queryRunner.query(`
      ALTER TABLE "event_store"."stored_events"
      ADD COLUMN IF NOT EXISTS "producerEventId" uuid
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_stored_events_tenant_producer_event"
      ON "event_store"."stored_events" ("tenantId", "producer", "producerEventId")
      WHERE "producer" IS NOT NULL AND "producerEventId" IS NOT NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "event_store"."projection_checkpoints"
      ADD COLUMN IF NOT EXISTS "generation" integer NOT NULL DEFAULT 1
    `);
    await queryRunner.query(`
      ALTER TABLE "event_store"."projection_checkpoints"
      ADD COLUMN IF NOT EXISTS "leaseOwner" character varying(255)
    `);
    await queryRunner.query(`
      ALTER TABLE "event_store"."projection_checkpoints"
      ADD COLUMN IF NOT EXISTS "leaseToken" uuid
    `);
    await queryRunner.query(`
      ALTER TABLE "event_store"."projection_checkpoints"
      ADD COLUMN IF NOT EXISTS "leaseExpiresAt" TIMESTAMP WITH TIME ZONE
    `);
    await queryRunner.query(`
      ALTER TABLE "event_store"."projection_checkpoints"
      ADD COLUMN IF NOT EXISTS "heartbeatAt" TIMESTAMP WITH TIME ZONE
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_projection_checkpoints_lease"
      ON "event_store"."projection_checkpoints" ("tenantId", "projectionName", "leaseExpiresAt")
    `);
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION "event_store"."reject_stored_events_mutation"()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        RAISE EXCEPTION 'event_store.stored_events is append-only';
      END;
      $$;
    `);
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS "TRG_stored_events_append_only_update"
      ON "event_store"."stored_events"
    `);
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS "TRG_stored_events_append_only_delete"
      ON "event_store"."stored_events"
    `);
    await queryRunner.query(`
      -- DESTRUCTIVE: no data removal, manages append-only truncation guard. Rollback: down() drops this trigger.
      DROP TRIGGER IF EXISTS "TRG_stored_events_append_only_truncate"
      ON "event_store"."stored_events"
    `);
    await queryRunner.query(`
      CREATE TRIGGER "TRG_stored_events_append_only_update"
      BEFORE UPDATE ON "event_store"."stored_events"
      FOR EACH ROW EXECUTE FUNCTION "event_store"."reject_stored_events_mutation"()
    `);
    await queryRunner.query(`
      CREATE TRIGGER "TRG_stored_events_append_only_delete"
      BEFORE DELETE ON "event_store"."stored_events"
      FOR EACH ROW EXECUTE FUNCTION "event_store"."reject_stored_events_mutation"()
    `);
    await queryRunner.query(`
      -- DESTRUCTIVE: no data removal, installs append-only truncation guard. Rollback: down() drops this trigger.
      CREATE TRIGGER "TRG_stored_events_append_only_truncate"
      BEFORE TRUNCATE ON "event_store"."stored_events"
      FOR EACH STATEMENT EXECUTE FUNCTION "event_store"."reject_stored_events_mutation"()
    `);
    await this.installTenantPolicies(queryRunner);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const table of [
      'append_idempotency',
      'event_streams',
      'projection_checkpoints',
      'projection_inbox',
      'snapshots',
      'stored_events',
    ]) {
      await queryRunner.query(`
        DROP POLICY IF EXISTS "${table}_tenant_policy"
        ON "event_store"."${table}"
      `);
    }
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS "TRG_stored_events_append_only_delete"
      ON "event_store"."stored_events"
    `);
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS "TRG_stored_events_append_only_update"
      ON "event_store"."stored_events"
    `);
    await queryRunner.query(`
      -- DESTRUCTIVE: no data removal, removes append-only truncation guard during rollback.
      DROP TRIGGER IF EXISTS "TRG_stored_events_append_only_truncate"
      ON "event_store"."stored_events"
    `);
    await queryRunner.query(`
      DROP FUNCTION IF EXISTS "event_store"."reject_stored_events_mutation"()
    `);
    await queryRunner.query(`
      DROP INDEX IF EXISTS "event_store"."IDX_stored_events_tenant_producer_event"
    `);
    await queryRunner.query(`
      ALTER TABLE "event_store"."stored_events"
      DROP COLUMN IF EXISTS "producerEventId"
    `);
    await queryRunner.query(`
      ALTER TABLE "event_store"."stored_events"
      DROP COLUMN IF EXISTS "producer"
    `);
    await queryRunner.query(`DROP TABLE IF EXISTS "event_store"."ledger_cursors"`);
    await queryRunner.query(`
      DROP INDEX IF EXISTS "event_store"."IDX_projection_checkpoints_lease"
    `);
    await queryRunner.query(`
      ALTER TABLE "event_store"."projection_checkpoints"
      DROP COLUMN IF EXISTS "heartbeatAt"
    `);
    await queryRunner.query(`
      ALTER TABLE "event_store"."projection_checkpoints"
      DROP COLUMN IF EXISTS "leaseExpiresAt"
    `);
    await queryRunner.query(`
      ALTER TABLE "event_store"."projection_checkpoints"
      DROP COLUMN IF EXISTS "leaseToken"
    `);
    await queryRunner.query(`
      ALTER TABLE "event_store"."projection_checkpoints"
      DROP COLUMN IF EXISTS "leaseOwner"
    `);
    await queryRunner.query(`
      ALTER TABLE "event_store"."projection_checkpoints"
      DROP COLUMN IF EXISTS "generation"
    `);
    await queryRunner.query(`DROP INDEX IF EXISTS "event_store"."IDX_append_idempotency_tenant_producer_key"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "event_store"."append_idempotency"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "event_store"."append_idempotency_status_enum"`);
  }

  private async installTenantPolicies(queryRunner: QueryRunner): Promise<void> {
    const currentTenant =
      `NULLIF(current_setting('app.current_tenant', true), '')::uuid`;
    const predicate =
      `(current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = ${currentTenant})`;

    for (const table of [
      'append_idempotency',
      'event_streams',
      'projection_checkpoints',
      'projection_inbox',
      'snapshots',
      'stored_events',
    ]) {
      await queryRunner.query(`
        ALTER TABLE "event_store"."${table}" ENABLE ROW LEVEL SECURITY
      `);
      await queryRunner.query(`
        ALTER TABLE "event_store"."${table}" FORCE ROW LEVEL SECURITY
      `);
      await queryRunner.query(`
        DROP POLICY IF EXISTS "tenant_isolation_policy"
        ON "event_store"."${table}"
      `);
      await queryRunner.query(`
        DROP POLICY IF EXISTS "${table}_tenant_policy"
        ON "event_store"."${table}"
      `);
      await queryRunner.query(`
        CREATE POLICY "${table}_tenant_policy"
        ON "event_store"."${table}"
        FOR ALL
        USING ${predicate}
        WITH CHECK ${predicate}
      `);
    }
  }
}
