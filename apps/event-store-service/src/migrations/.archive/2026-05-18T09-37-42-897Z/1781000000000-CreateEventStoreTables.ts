import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CreateEventStoreTables1781000000000
 * ============================================================================
 *
 * Baseline migration for the `event_store` schema. Creates the 4 core
 * event-sourcing tables the service consumes:
 *
 *   - stored_events            — immutable append-only event log
 *   - event_streams            — per-stream metadata (current version, event count)
 *   - snapshots                — aggregate state snapshots (event-replay cache)
 *   - projection_checkpoints   — per-projection subscription offsets + metrics
 *
 * # Why this migration existed to be written
 *
 * All 4 entities (@Entity decorators in
 * apps/event-store-service/src/event-store/entities/ and
 * apps/event-store-service/src/projections/entities/) were created but no
 * CREATE TABLE migration was committed alongside. The service relied on
 * TypeORM `synchronize: true` in dev; production forbids synchronize
 * (CLAUDE.md) so the tables never materialised.
 *
 * AddStoredEventsImmutabilityTriggers1782000000000 assumes `stored_events`
 * exists and failed deploy with
 *   relation "stored_events" does not exist
 *
 * This migration fills the gap with entity-derived DDL. Ordering: timestamp
 * 1781000000000 < 1782000000000 so the orchestrator discovers this one
 * first.
 *
 * # Architectural invariant (future-proofing)
 *
 * `e2e/tests/integration/entity-migration-parity.spec.ts` (MA2) enforces
 * that every @Entity across the platform has a corresponding CREATE TABLE
 * statement in its service's migrations directory — making this class of
 * gap impossible to reintroduce.
 *
 * # Partial-state safety
 *
 * Prior deploys may have created some of these tables via TypeORM
 * synchronize in a dev-style environment. `CREATE TABLE IF NOT EXISTS`
 * + `CREATE INDEX IF NOT EXISTS` + `CREATE OR REPLACE FUNCTION` handle
 * that cleanly. `CREATE TRIGGER` does NOT support IF NOT EXISTS, so the
 * trigger creation is wrapped in a DO block that catches duplicate_object.
 *
 * # Column names
 *
 * TypeORM's default column-naming strategy preserves the property name.
 * Event-store entities declare camelCase properties without explicit
 * `@Column({ name: '...' })` overrides, so DB columns are camelCase
 * (streamName, globalPosition, tenantId, createdAt, etc.). This differs
 * from HR's snake_case convention — intentional per-service choice,
 * validated by MA3's column-name parity invariant.
 */
export class CreateEventStoreTables1781000000000 implements MigrationInterface {
  name = 'CreateEventStoreTables1781000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Pin search_path (defense-in-depth; orchestrator already pins). Ensures
    // every unqualified CREATE statement below lands in event_store.
    await queryRunner.query(`SET search_path TO "event_store", public`);

    // ── Enum: projection_status ────────────────────────────────────────────
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE projection_status AS ENUM ('running', 'paused', 'stopped', 'faulted');
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);

    // ── Table: stored_events ───────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "stored_events" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "streamName" varchar(255) NOT NULL,
        "globalPosition" bigint NOT NULL,
        "streamPosition" bigint NOT NULL,
        "aggregateType" varchar(255) NOT NULL,
        "aggregateId" uuid NOT NULL,
        "version" int NOT NULL,
        "eventType" varchar(255) NOT NULL,
        "payload" jsonb NOT NULL,
        "metadata" jsonb,
        "tenantId" uuid NOT NULL,
        "correlationId" uuid,
        "causationId" uuid,
        "userId" uuid,
        "occurredAt" timestamptz NOT NULL,
        "storedAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "schemaVersion" int NOT NULL DEFAULT 1
      )
    `);

    // stored_events indexes (9 per-decorator + 3 composite tenant-prefix)
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_stored_events_aggregateType_aggregateId_version"
      ON "stored_events" ("aggregateType", "aggregateId", "version")
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_stored_events_globalPosition"
      ON "stored_events" ("globalPosition")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_stored_events_streamName"
      ON "stored_events" ("streamName")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_stored_events_eventType"
      ON "stored_events" ("eventType")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_stored_events_tenantId"
      ON "stored_events" ("tenantId")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_stored_events_occurredAt"
      ON "stored_events" ("occurredAt")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_stored_events_correlationId"
      ON "stored_events" ("correlationId")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_stored_events_tenant_streamName_version"
      ON "stored_events" ("tenantId", "streamName", "version")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_stored_events_tenant_globalPosition"
      ON "stored_events" ("tenantId", "globalPosition")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_stored_events_tenant_eventType"
      ON "stored_events" ("tenantId", "eventType")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_stored_events_tenant_storedAt"
      ON "stored_events" ("tenantId", "storedAt")
    `);
    // Explicit name from @Index('IDX_stored_events_tenant_aggregate_version', ...)
    // decorator — DATA-MEDIUM-013 composite for tenant-scoped aggregate replay.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_stored_events_tenant_aggregate_version"
      ON "stored_events" ("tenantId", "aggregateId", "version")
    `);

    // ── Table: event_streams ───────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "event_streams" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "streamName" varchar(255) NOT NULL,
        "aggregateType" varchar(255) NOT NULL,
        "aggregateId" uuid NOT NULL,
        "currentVersion" int NOT NULL DEFAULT 0,
        "eventCount" bigint NOT NULL DEFAULT 0,
        "tenantId" uuid NOT NULL,
        "isDeleted" boolean NOT NULL DEFAULT false,
        "createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "lastEventAt" timestamptz
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_event_streams_tenant_streamName"
      ON "event_streams" ("tenantId", "streamName")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_event_streams_tenantId"
      ON "event_streams" ("tenantId")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_event_streams_aggregateType"
      ON "event_streams" ("aggregateType")
    `);

    // ── Table: snapshots ───────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "snapshots" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "aggregateType" varchar(255) NOT NULL,
        "aggregateId" uuid NOT NULL,
        "version" int NOT NULL,
        "state" jsonb NOT NULL,
        "tenantId" uuid NOT NULL,
        "createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "schemaVersion" int NOT NULL DEFAULT 1
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_snapshots_aggregateType_aggregateId_tenantId"
      ON "snapshots" ("aggregateType", "aggregateId", "tenantId")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_snapshots_tenantId"
      ON "snapshots" ("tenantId")
    `);

    // ── Table: projection_checkpoints ──────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "projection_checkpoints" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "projectionName" varchar(255) NOT NULL,
        "description" varchar(500),
        "position" bigint NOT NULL DEFAULT 0,
        "status" projection_status NOT NULL DEFAULT 'running',
        "tenantId" uuid NOT NULL,
        "consumerGroup" varchar(100),
        "eventTypes" jsonb NOT NULL DEFAULT '[]',
        "aggregateTypes" jsonb NOT NULL DEFAULT '[]',
        "eventsProcessed" bigint NOT NULL DEFAULT 0,
        "eventsFailed" bigint NOT NULL DEFAULT 0,
        "lastError" text,
        "lastErrorAt" timestamptz,
        "avgProcessingTimeMs" double precision NOT NULL DEFAULT 0,
        "createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "lastProcessedAt" timestamptz
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_projection_checkpoints_tenant_projectionName"
      ON "projection_checkpoints" ("tenantId", "projectionName")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_projection_checkpoints_tenantId"
      ON "projection_checkpoints" ("tenantId")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_projection_checkpoints_status"
      ON "projection_checkpoints" ("status")
    `);

    // ── UpdateDateColumn triggers ──────────────────────────────────────────
    //
    // @UpdateDateColumn in TypeORM updates the `updatedAt` column at the
    // ORM layer. Any UPDATE issued via raw SQL (batch jobs, maintenance
    // scripts, replication) bypasses the ORM and the column would not tick.
    // A BEFORE UPDATE trigger keeps the invariant ("updatedAt reflects the
    // last write of any origin") honest at the database level.
    //
    // CREATE TRIGGER does not support IF NOT EXISTS; wrap in a DO block
    // that catches duplicate_object so the migration is idempotent on
    // retry after a partial crash.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION event_store_update_updated_at()
      RETURNS TRIGGER AS $$
      BEGIN
        NEW."updatedAt" = CURRENT_TIMESTAMP;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TRIGGER trigger_event_streams_updated_at
        BEFORE UPDATE ON "event_streams"
        FOR EACH ROW EXECUTE FUNCTION event_store_update_updated_at();
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TRIGGER trigger_projection_checkpoints_updated_at
        BEFORE UPDATE ON "projection_checkpoints"
        FOR EACH ROW EXECUTE FUNCTION event_store_update_updated_at();
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET search_path TO "event_store", public`);

    // Triggers first (depend on function)
    await queryRunner.query(`DROP TRIGGER IF EXISTS trigger_projection_checkpoints_updated_at ON "projection_checkpoints"`);
    await queryRunner.query(`DROP TRIGGER IF EXISTS trigger_event_streams_updated_at ON "event_streams"`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS event_store_update_updated_at()`);

    // Tables (reverse creation order). Indexes drop with CASCADE.
    await queryRunner.query(`DROP TABLE IF EXISTS "projection_checkpoints" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "snapshots" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "event_streams" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "stored_events" CASCADE`);

    // Enum last (referenced by projection_checkpoints.status)
    await queryRunner.query(`DROP TYPE IF EXISTS projection_status`);
  }
}
