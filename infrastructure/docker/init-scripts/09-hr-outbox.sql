-- ============================================================================
-- 09-hr-outbox.sql
--
-- Creates hr_outbox table matching OutboxEntityBase (platform/libs/outbox/
-- src/outbox-entity.base.ts) + the idempotent NOTIFY trigger the shared
-- OutboxNotifyListener relies on.
--
-- # Why an init-script and not a TypeORM migration?
--
-- hr-service does not yet have a TypeORM migration runner wired (see
-- apps/hr-service/src/app.module.ts:300 — *"hr-service has no TypeORM
-- migration runner — it currently delivers schema concerns through
-- OnApplicationBootstrap services"*). The same architectural gap applies
-- to billing/config/notification/alert/ai/event-store. Plan P2 of the
-- 2026-04-14 teardown wires proper migration runners to all of these;
-- until then, init-scripts are the shared mechanism used by farm-service
-- (03-farm-tables-and-seed.sql) and billing-service (04-billing-tables.sql).
--
-- Once P2 lands for hr-service, this file's contents become the initial
-- migration (apps/hr-service/src/database/migrations/…-CreateHrOutbox.ts)
-- and this init-script is deleted. The idempotency guards below make the
-- cutover safe (re-running is a no-op).
--
-- # Acute bug this closes
--
-- Before this file, every 5 seconds on boot hr-service logged:
--   Outbox poll cycle failed: relation "hr_outbox" does not exist
-- The OutboxWorkerService was polling a table its entity declared
-- (apps/hr-service/src/hr/entities/hr-outbox.entity.ts:19) but nothing
-- ever created. Event delivery for leave approvals / terminations /
-- certifications was silently lost — the outbox pattern's at-least-once
-- guarantee was vacuous without the table.
--
-- # Why hr_outbox is NOT per-tenant copied
--
-- The outbox is shared across tenants, partitioned internally by the
-- tenantId column. Per-tenant schema replication would produce N
-- identical polling queues for one worker to serve — operationally
-- worse than a single shared queue with a tenantId index. Matches the
-- farm_outbox pattern (see MODULE_SCHEMAS[farm].infrastructureTables).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Create the table in `hr` schema
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS hr.hr_outbox (
  "id"              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "eventType"       VARCHAR(100) NOT NULL,
  "tenantId"        UUID,
  "aggregateId"     UUID,
  "payload"         JSONB NOT NULL,
  "createdAt"       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "publishedAt"     TIMESTAMPTZ,
  "retryCount"      INTEGER NOT NULL DEFAULT 0,
  "lastError"       TEXT,
  "nextAttemptAt"   TIMESTAMPTZ,
  "idempotencyKey"  VARCHAR(255),
  "isDeadLettered"  BOOLEAN NOT NULL DEFAULT false,
  "leasedAt"        TIMESTAMPTZ,
  "leasedBy"        VARCHAR(128)
);

ALTER TABLE hr.hr_outbox OWNER TO hr_service;

-- ----------------------------------------------------------------------------
-- 2. Indexes matching the OutboxWorkerService polling predicate
-- ----------------------------------------------------------------------------

-- Hot-path poll index: unpublished, not dead-lettered, eligible-for-retry
-- rows ordered by createdAt. Partial (publishedAt IS NULL) keeps it small.
CREATE INDEX IF NOT EXISTS idx_hr_outbox_poll
  ON hr.hr_outbox ("createdAt" ASC)
  WHERE "publishedAt" IS NULL AND "isDeadLettered" = false;

-- Retention index for nightly cleanup (delete published rows >7 days old).
CREATE INDEX IF NOT EXISTS idx_hr_outbox_published_at
  ON hr.hr_outbox ("publishedAt")
  WHERE "publishedAt" IS NOT NULL;

-- Idempotent enqueue: UNIQUE on (tenantId, idempotencyKey) when both present.
-- Nullable columns with partial index — retry of the same command handler
-- in the same tenant context is rejected by the DB, not by handler code.
CREATE UNIQUE INDEX IF NOT EXISTS idx_hr_outbox_idempotency
  ON hr.hr_outbox ("tenantId", "idempotencyKey")
  WHERE "idempotencyKey" IS NOT NULL;

-- Lease-expiry recovery index for the worker's stuck-row scan.
CREATE INDEX IF NOT EXISTS idx_hr_outbox_lease
  ON hr.hr_outbox ("leasedAt")
  WHERE "leasedAt" IS NOT NULL AND "publishedAt" IS NULL;

-- ----------------------------------------------------------------------------
-- 3. NOTIFY trigger for event-driven wake-up
--
-- OutboxNotifyListener holds a LISTEN hr_outbox_notify session; this
-- trigger fires pg_notify after every INSERT commit, so the worker wakes
-- within ~5ms of an enqueue instead of waiting for its 5-second cron.
-- Channel naming follows the `<table>_notify` convention — the shared
-- listener derives this name from entity metadata, so drift between
-- trigger and listener is impossible without touching both sides.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION hr.notify_hr_outbox_new()
  RETURNS TRIGGER
  LANGUAGE plpgsql
AS $$
BEGIN
  -- Empty payload — the listener uses the notification as a pure wake
  -- signal. The worker's acquireLease() reads rows itself via
  -- FOR UPDATE SKIP LOCKED, so carrying row data on the NOTIFY channel
  -- would duplicate work.
  PERFORM pg_notify('hr_outbox_notify', '');
  RETURN NULL;
END;
$$;

ALTER FUNCTION hr.notify_hr_outbox_new() OWNER TO hr_service;

DROP TRIGGER IF EXISTS hr_outbox_notify_trigger ON hr.hr_outbox;

CREATE TRIGGER hr_outbox_notify_trigger
  AFTER INSERT ON hr.hr_outbox
  FOR EACH ROW
  EXECUTE FUNCTION hr.notify_hr_outbox_new();
