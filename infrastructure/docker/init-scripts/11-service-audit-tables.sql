-- ============================================================================
-- 11-service-audit-tables.sql
--
-- Creates the per-service audit tables that the schema-anchored entities
-- introduced by P9 + commit b3df4608 declare:
--
--   - auth.audit_logs   (auth-service's operational audit:
--                        login/MFA/token/permission events)
--   - admin.audit_logs  (admin-api SUPER_ADMIN actions: tenant
--                        impersonation, suspension, plan changes)
--
-- Closes NEW-HIGH-C from the round-2 review. Without these CREATE
-- TABLE statements, the schema-anchored entities in commit b3df4608
-- (`@Entity('audit_logs', { schema: 'auth' })` and
-- `@Entity('audit_logs', { schema: 'admin' })`) point at non-existent
-- tables on fresh deploys, since both services run with
-- `synchronize: false` in production. First INSERT crashes with
-- `relation "auth.audit_logs" does not exist` and silently kills the
-- compliance audit trail for those services.
--
-- # Why init-script and not TypeORM migration
--
-- auth-service has its own TypeORM migration runner (existing migrations
-- in apps/auth-service/src/migrations/) — could land there. But the
-- equivalent admin-api migration would have to land in admin-api's
-- explicit migrations[] list (apps/admin-api-service/src/app.module.ts:78-81
-- — not the autoApply factory like billing/config/notification got in
-- P2b-c). Splitting across two services for one architectural concern
-- adds review surface for no benefit.
--
-- The init-script pattern matches what 04-billing-tables.sql did for
-- billing.* and what 09-hr-outbox.sql did for hr.hr_outbox: tables that
-- "just need to exist" before any service queries them, owned by their
-- service's role.
--
-- # ENUM types
--
-- Each entity declares a TypeScript enum stored as a PG enum type.
-- The two enums (auth_audit_severity and admin_audit_severity) differ
-- by one value (auth has ERROR, admin doesn't) — so they're separate
-- types in distinct schemas. Idempotency wrappers prevent duplicate-
-- type errors on re-run.
--
-- # Idempotency
--
-- Every CREATE statement uses IF NOT EXISTS. Type creation uses
-- DO $$ ... EXCEPTION WHEN duplicate_object (the canonical PG idiom).
-- Safe to re-run on environments where the tables already exist
-- (synchronize: true dev runs, manual psql apply).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. auth.audit_logs
-- Mirrors apps/auth-service/src/audit/audit-log.entity.ts:44
-- ----------------------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE auth.audit_log_severity AS ENUM ('info', 'warning', 'error', 'critical');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS auth.audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "performedBy" VARCHAR(100) NOT NULL,
  "performedByEmail" VARCHAR(100),
  action VARCHAR(100) NOT NULL,
  "entityType" VARCHAR(50) NOT NULL,
  "entityId" UUID,
  "tenantId" UUID,
  details JSONB,
  "previousValue" JSONB,
  "newValue" JSONB,
  severity auth.audit_log_severity NOT NULL DEFAULT 'info',
  "requestId" VARCHAR(100),
  "sessionId" VARCHAR(100),
  "ipAddress" VARCHAR(45),
  "userAgent" VARCHAR(500),
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "IDX_audit_tenant_created" ON auth.audit_logs ("tenantId", "createdAt");
CREATE INDEX IF NOT EXISTS "IDX_audit_performer_tenant" ON auth.audit_logs ("performedBy", "tenantId");
CREATE INDEX IF NOT EXISTS "IDX_audit_entity" ON auth.audit_logs ("entityType", "entityId", "tenantId");

ALTER TABLE auth.audit_logs OWNER TO auth_service;

-- ----------------------------------------------------------------------------
-- 2. admin.audit_logs
-- Mirrors apps/admin-api-service/src/audit/audit.entity.ts:83
-- ----------------------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE admin.audit_severity AS ENUM ('info', 'warning', 'critical');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS admin.audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  action VARCHAR(100) NOT NULL,
  "entityType" VARCHAR(50) NOT NULL,
  "entityId" UUID,
  "tenantId" UUID,
  "performedBy" VARCHAR(100) NOT NULL,
  "performedByEmail" VARCHAR(100),
  "ipAddress" VARCHAR(45),
  "userAgent" VARCHAR(500),
  details JSONB,
  "previousValue" JSONB,
  "newValue" JSONB,
  severity admin.audit_severity NOT NULL DEFAULT 'info',
  "requestId" VARCHAR(100),
  "sessionId" VARCHAR(100),
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_action ON admin.audit_logs (action);
CREATE INDEX IF NOT EXISTS idx_admin_audit_entity ON admin.audit_logs ("entityType", "entityId");
CREATE INDEX IF NOT EXISTS idx_admin_audit_performer ON admin.audit_logs ("performedBy");
CREATE INDEX IF NOT EXISTS idx_admin_audit_tenant ON admin.audit_logs ("tenantId");
CREATE INDEX IF NOT EXISTS idx_admin_audit_created ON admin.audit_logs ("createdAt");
CREATE INDEX IF NOT EXISTS idx_admin_audit_severity ON admin.audit_logs (severity);

ALTER TABLE admin.audit_logs OWNER TO admin_service;
