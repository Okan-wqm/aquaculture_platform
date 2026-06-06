import { MigrationInterface, QueryRunner } from 'typeorm';

export class EventLedgerHardening1800100000000 implements MigrationInterface {
  name = 'EventLedgerHardening1800100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);

    await queryRunner.query(`
      CREATE SEQUENCE IF NOT EXISTS "event_store"."stored_events_global_position_seq"
    `);
    await queryRunner.query(`
      SELECT setval(
        '"event_store"."stored_events_global_position_seq"',
        GREATEST(COALESCE((SELECT MAX("globalPosition") FROM "event_store"."stored_events"), 0), 1),
        true
      )
    `);
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION "event_store"."assign_stored_event_global_position"()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF NEW."globalPosition" IS NULL OR NEW."globalPosition" <= 0 THEN
          NEW."globalPosition" := nextval('"event_store"."stored_events_global_position_seq"');
        END IF;
        RETURN NEW;
      END;
      $$;
    `);
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS "trg_assign_stored_event_global_position"
      ON "event_store"."stored_events"
    `);
    await queryRunner.query(`
      CREATE TRIGGER "trg_assign_stored_event_global_position"
      BEFORE INSERT ON "event_store"."stored_events"
      FOR EACH ROW
      EXECUTE FUNCTION "event_store"."assign_stored_event_global_position"()
    `);
    await queryRunner.query(`
      ALTER TABLE "event_store"."stored_events"
      ALTER COLUMN "globalPosition"
      SET DEFAULT nextval('"event_store"."stored_events_global_position_seq"')
    `);

    await queryRunner.query(`
      ALTER TABLE "event_store"."stored_events"
      ADD COLUMN IF NOT EXISTS "producer" character varying(100)
    `);
    await queryRunner.query(`
      UPDATE "event_store"."stored_events"
      SET "producer" = 'legacy-import'
      WHERE "producer" IS NULL
    `);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = 'event_store'
            AND table_name = 'stored_events'
            AND column_name = 'producer'
            AND is_nullable = 'YES'
        ) THEN
          ALTER TABLE "event_store"."stored_events"
          ALTER COLUMN "producer" SET NOT NULL;
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      ALTER TABLE "event_store"."stored_events"
      ADD COLUMN IF NOT EXISTS "producerEventId" character varying(255)
    `);
    await queryRunner.query(`
      UPDATE "event_store"."stored_events"
      SET "producerEventId" = 'legacy:' || "id"::text
      WHERE "producerEventId" IS NULL
    `);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = 'event_store'
            AND table_name = 'stored_events'
            AND column_name = 'producerEventId'
            AND is_nullable = 'YES'
        ) THEN
          ALTER TABLE "event_store"."stored_events"
          ALTER COLUMN "producerEventId" SET NOT NULL;
        END IF;
      END $$;
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_stored_events_tenant_producer_event"
      ON "event_store"."stored_events" ("tenantId", "producer", "producerEventId")
    `);

    await queryRunner.query(`
      ALTER TABLE "event_store"."snapshots"
      ADD COLUMN IF NOT EXISTS "stateHash" character(64)
    `);
    await queryRunner.query(`
      UPDATE "event_store"."snapshots"
      SET "stateHash" = encode(digest("state"::text, 'sha256'), 'hex')
      WHERE "stateHash" IS NULL
    `);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = 'event_store'
            AND table_name = 'snapshots'
            AND column_name = 'stateHash'
            AND is_nullable = 'YES'
        ) THEN
          ALTER TABLE "event_store"."snapshots"
          ALTER COLUMN "stateHash" SET NOT NULL;
        END IF;
      END $$;
    `);
    await queryRunner.query(`
      DROP INDEX IF EXISTS "event_store"."IDX_f9eb2ef365ee551cb36ce80d5e"
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_snapshots_tenant_aggregate_version"
      ON "event_store"."snapshots" ("aggregateType", "aggregateId", "tenantId", "version")
    `);

    await queryRunner.query(`
      ALTER TABLE "event_store"."projection_checkpoints"
      ADD COLUMN IF NOT EXISTS "generation" integer NOT NULL DEFAULT 0
    `);
    await queryRunner.query(`
      ALTER TABLE "event_store"."projection_checkpoints"
      ADD COLUMN IF NOT EXISTS "leaseToken" uuid
    `);

    await queryRunner.query(`
      DROP INDEX IF EXISTS "event_store"."IDX_stored_events_tenant_aggregate_version"
    `);
    await queryRunner.query(`
      DROP INDEX IF EXISTS "event_store"."IDX_aebc68416a5ae504289cb6893d"
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_stored_events_tenant_aggregate_version"
      ON "event_store"."stored_events" ("tenantId", "aggregateType", "aggregateId", "version")
    `);
    await queryRunner.query(`
      DROP INDEX IF EXISTS "event_store"."IDX_f4d48d93de16997398b325ab45"
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_stored_events_tenant_stream_version"
      ON "event_store"."stored_events" ("tenantId", "streamName", "version")
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION "event_store"."reject_immutable_ledger_mutation"()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        RAISE EXCEPTION 'event_store.% is append-only; % is forbidden', TG_TABLE_NAME, TG_OP
          USING ERRCODE = 'object_not_in_prerequisite_state';
      END;
      $$;
    `);
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS "trg_stored_events_append_only"
      ON "event_store"."stored_events"
    `);
    await queryRunner.query(`
      CREATE TRIGGER "trg_stored_events_append_only"
      BEFORE UPDATE OR DELETE ON "event_store"."stored_events"
      FOR EACH ROW
      EXECUTE FUNCTION "event_store"."reject_immutable_ledger_mutation"()
    `);
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS "trg_snapshots_immutable"
      ON "event_store"."snapshots"
    `);
    await queryRunner.query(`
      CREATE TRIGGER "trg_snapshots_immutable"
      BEFORE UPDATE OR DELETE ON "event_store"."snapshots"
      FOR EACH ROW
      EXECUTE FUNCTION "event_store"."reject_immutable_ledger_mutation"()
    `);
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS "trg_event_streams_no_delete"
      ON "event_store"."event_streams"
    `);
    await queryRunner.query(`
      CREATE TRIGGER "trg_event_streams_no_delete"
      BEFORE DELETE ON "event_store"."event_streams"
      FOR EACH ROW
      EXECUTE FUNCTION "event_store"."reject_immutable_ledger_mutation"()
    `);

    for (const table of ['stored_events', 'event_streams', 'snapshots', 'projection_checkpoints']) {
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
        CREATE POLICY "tenant_isolation_policy"
        ON "event_store"."${table}"
        USING (
          current_setting('app.bypass_rls', true) = 'on'
          OR "tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid
        )
        WITH CHECK (
          current_setting('app.bypass_rls', true) = 'on'
          OR "tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid
        )
      `);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const table of ['stored_events', 'event_streams', 'snapshots', 'projection_checkpoints']) {
      await queryRunner.query(`
        DROP POLICY IF EXISTS "tenant_isolation_policy"
        ON "event_store"."${table}"
      `);
      await queryRunner.query(`
        ALTER TABLE "event_store"."${table}" NO FORCE ROW LEVEL SECURITY
      `);
      await queryRunner.query(`
        ALTER TABLE "event_store"."${table}" DISABLE ROW LEVEL SECURITY
      `);
    }

    await queryRunner.query(`
      DROP TRIGGER IF EXISTS "trg_event_streams_no_delete"
      ON "event_store"."event_streams"
    `);
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS "trg_snapshots_immutable"
      ON "event_store"."snapshots"
    `);
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS "trg_stored_events_append_only"
      ON "event_store"."stored_events"
    `);
    await queryRunner.query(`
      DROP FUNCTION IF EXISTS "event_store"."reject_immutable_ledger_mutation"()
    `);

    await queryRunner.query(`
      DROP INDEX IF EXISTS "event_store"."IDX_stored_events_tenant_stream_version"
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_f4d48d93de16997398b325ab45"
      ON "event_store"."stored_events" ("tenantId", "streamName", "version")
    `);
    await queryRunner.query(`
      DROP INDEX IF EXISTS "event_store"."IDX_stored_events_tenant_aggregate_version"
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_aebc68416a5ae504289cb6893d"
      ON "event_store"."stored_events" ("aggregateType", "aggregateId", "version")
    `);

    await queryRunner.query(`
      ALTER TABLE "event_store"."projection_checkpoints"
      DROP COLUMN IF EXISTS "leaseToken"
    `);
    await queryRunner.query(`
      ALTER TABLE "event_store"."projection_checkpoints"
      DROP COLUMN IF EXISTS "generation"
    `);

    await queryRunner.query(`
      DROP INDEX IF EXISTS "event_store"."IDX_snapshots_tenant_aggregate_version"
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_f9eb2ef365ee551cb36ce80d5e"
      ON "event_store"."snapshots" ("aggregateType", "aggregateId", "tenantId")
    `);
    await queryRunner.query(`
      ALTER TABLE "event_store"."snapshots"
      DROP COLUMN IF EXISTS "stateHash"
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

    await queryRunner.query(`
      ALTER TABLE "event_store"."stored_events"
      ALTER COLUMN "globalPosition" DROP DEFAULT
    `);
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS "trg_assign_stored_event_global_position"
      ON "event_store"."stored_events"
    `);
    await queryRunner.query(`
      DROP FUNCTION IF EXISTS "event_store"."assign_stored_event_global_position"()
    `);
    await queryRunner.query(`
      DROP SEQUENCE IF EXISTS "event_store"."stored_events_global_position_seq"
    `);
  }
}
