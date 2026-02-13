-- Migration: V006__add_tenant_tracking_columns.sql
-- Description: Add storage limit, trial status, usage counters, and optimistic
--              locking version column to the auth.tenants table.
-- Date: 2026-02-12
--
-- These columns support:
--   - max_storage: per-tenant storage quota (-1 = unlimited)
--   - is_trial_active: whether the tenant is currently on a trial period
--   - user_count / farm_count / sensor_count: cached usage counters for quick
--     limit checks without cross-service queries
--   - version: optimistic locking column used by TypeORM @VersionColumn

-- Storage quota (default -1 means unlimited)
ALTER TABLE auth.tenants ADD COLUMN IF NOT EXISTS max_storage INTEGER DEFAULT -1;

-- Trial tracking
ALTER TABLE auth.tenants ADD COLUMN IF NOT EXISTS is_trial_active BOOLEAN DEFAULT false;

-- Cached usage counters for fast limit checks
ALTER TABLE auth.tenants ADD COLUMN IF NOT EXISTS user_count INTEGER DEFAULT 0;
ALTER TABLE auth.tenants ADD COLUMN IF NOT EXISTS farm_count INTEGER DEFAULT 0;
ALTER TABLE auth.tenants ADD COLUMN IF NOT EXISTS sensor_count INTEGER DEFAULT 0;

-- Optimistic locking version (TypeORM @VersionColumn)
ALTER TABLE auth.tenants ADD COLUMN IF NOT EXISTS version INTEGER DEFAULT 1;
