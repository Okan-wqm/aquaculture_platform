-- =============================================================================
-- Aquaculture Platform — Database-Level Bootstrap (initdb-only)
--
-- This is the ONLY init-script that remains after ADR-031 (Platform Bootstrap
-- Atom). Its contents must hold the following invariant:
--
--   "Everything in this file is safe to apply EXACTLY ONCE at initdb time
--    and is NEVER re-applied on container restart."
--
-- Why this file still exists:
--   - Database-level GRANTs (GRANT ALL PRIVILEGES ON DATABASE ...) cannot
--     be issued from a TypeORM migration because the migration runner role
--     does not own the database. They must run as the postgres superuser
--     during initdb.
--   - Defensive CREATE EXTENSION IF NOT EXISTS for the 3 cluster-level
--     extensions that aqua-db-migrate also installs (apps/db-migrate/src/
--     sql/platform-bootstrap/001-extensions.sql) — keeps the database
--     usable for diagnostic psql sessions before db-migrate runs.
--
-- What is NOT in this file (moved to platform-bootstrap atom):
--   - CREATE SCHEMA + AUTHORIZATION  → 003-schemas.sql
--   - CREATE ROLE                    → platform-bootstrap.service.ts (env-aware)
--   - CREATE FUNCTION                → 005-platform-functions.sql
--   - Shared schema + tables          → 006-shared-schema-tables.sql
--   - Per-schema GRANT + ALTER DEFAULT PRIVILEGES → 004-schema-grants.sql
--
-- The 4 archived files under .archive/ are kept for forensic reference —
-- they document the pre-ADR-031 contract.
--
-- IMPORTANT: any future schema/role/extension/function DDL belongs in the
-- platform-bootstrap atom, NOT here. CI invariant
-- tests/invariants/init-scripts-no-schema-ddl.spec.ts enforces this.
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
