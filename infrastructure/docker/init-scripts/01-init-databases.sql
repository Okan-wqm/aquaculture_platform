-- =============================================================================
-- Aquaculture Platform - Database Initialization
--
-- Cross-cutting database extensions + database-level GRANTs only.
--
-- # Why no CREATE TABLE statements live here anymore (Wave 4-A.2)
--
-- Pre-Wave 4 this script declared all auth.* tables (tenants, users,
-- invitations, tenant_modules, tenant_roles). Those CREATE TABLE
-- statements are now owned by the auth-service Wave 1 baseline migration
-- (apps/auth-service/src/migrations/1700000000000-CreateInitialSchema.ts)
-- which is the single source of truth — running through the proper
-- TypeORM migration ledger instead of init-script side effects.
--
-- Maintaining duplicate CREATE TABLE statements in two places (init script
-- + migration) drifted on every column addition. The Wave 4 cutover
-- consolidates ownership: the migration is authoritative, this init
-- script does the bare minimum (extensions, database GRANT) so the
-- Postgres bootstrap completes before the migration container runs.
--
-- # Why this script remains in init-scripts/
--
-- The migration container (apps/db-migrate) connects with the per-service
-- role created by 00-init-schemas.sh. Both 00 and this 01 script must
-- run as the postgres superuser before any service container starts.
-- Database-level GRANTs (`GRANT ALL PRIVILEGES ON DATABASE ...`) cannot
-- be issued from a TypeORM migration because the runner role does not
-- own the database.
-- =============================================================================

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- Database-level GRANT for the platform superuser. Per-schema and
-- per-table grants are emitted by 00-init-schemas.sh.
GRANT ALL PRIVILEGES ON DATABASE aquaculture TO aquaculture;

-- =============================================================================
-- SUPER_ADMIN seeding is NOT done here.
--
-- Reason: PostgreSQL's pgcrypto crypt() generates bcrypt hashes that are
-- incompatible with Node.js bcryptjs (different internal implementations).
-- This causes "invalid password" errors on first login.
--
-- The auth-service SeedService handles SUPER_ADMIN creation on startup using
-- bcryptjs with proper password strength validation and 12 salt rounds.
-- Configure via environment variables:
--   SUPER_ADMIN_EMAIL     — required in production
--   SUPER_ADMIN_PASSWORD  — required, min 12 chars, mixed case + digit + special
-- =============================================================================

DO $$
BEGIN
    RAISE NOTICE 'Database extensions installed and database-level GRANTs emitted.';
    RAISE NOTICE 'auth.* tables are owned by auth-service Wave 1 baseline migration.';
    RAISE NOTICE 'SUPER_ADMIN user will be seeded by auth-service on first startup.';
END $$;
