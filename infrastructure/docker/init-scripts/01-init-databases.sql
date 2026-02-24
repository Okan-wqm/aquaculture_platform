-- =============================================================================
-- Aquaculture Platform - Database Initialization
-- Core auth schema tables + extensions
-- These tables MUST match the TypeORM entities in auth-service exactly.
-- TypeORM synchronize will add any missing columns but having them here
-- ensures a clean database works from first boot without race conditions.
-- =============================================================================

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- Grant permissions
GRANT ALL PRIVILEGES ON DATABASE aquaculture TO aquaculture;

-- =============================================================================
-- auth.tenants — owned by auth-service, read by admin-api-service
-- Column names: TypeORM default camelCase except where entity specifies name:
--   @Column({ name: 'max_storage' })  → snake_case in DB
--   @Column()                         → camelCase in DB (TypeORM default)
-- =============================================================================
CREATE TABLE IF NOT EXISTS auth.tenants (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name                VARCHAR(255) NOT NULL,
    slug                VARCHAR(100) NOT NULL,
    description         TEXT,
    "logoUrl"           VARCHAR(500),
    "contactEmail"      VARCHAR(255),
    "contactPhone"      VARCHAR(50),
    address             TEXT,
    "taxId"             VARCHAR(100),
    status              VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    plan                VARCHAR(20) NOT NULL DEFAULT 'starter',
    "maxUsers"          INTEGER NOT NULL DEFAULT 5,
    max_storage         INTEGER NOT NULL DEFAULT -1,
    is_trial_active     BOOLEAN NOT NULL DEFAULT false,
    user_count          INTEGER NOT NULL DEFAULT 0,
    farm_count          INTEGER NOT NULL DEFAULT 0,
    sensor_count        INTEGER NOT NULL DEFAULT 0,
    "trialEndsAt"       TIMESTAMP,
    "subscriptionEndsAt" TIMESTAMP,
    "customDomain"      VARCHAR(255),
    settings            JSONB,
    "createdBy"         UUID,
    "createdAt"         TIMESTAMP NOT NULL DEFAULT NOW(),
    "updatedAt"         TIMESTAMP NOT NULL DEFAULT NOW(),
    version             INTEGER NOT NULL DEFAULT 1,
    CONSTRAINT "UQ_tenants_slug" UNIQUE (slug)
);

CREATE INDEX IF NOT EXISTS "IDX_tenants_slug" ON auth.tenants (slug);
CREATE INDEX IF NOT EXISTS "IDX_tenants_status" ON auth.tenants (status);

-- =============================================================================
-- auth.users — owned by auth-service
-- =============================================================================
CREATE TABLE IF NOT EXISTS auth.users (
    id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email                   VARCHAR(255) NOT NULL,
    password                VARCHAR(255),
    "firstName"             VARCHAR(100),
    "lastName"              VARCHAR(100),
    role                    VARCHAR(50) NOT NULL DEFAULT 'MODULE_USER',
    "tenantId"              UUID,
    "isActive"              BOOLEAN NOT NULL DEFAULT true,
    "isEmailVerified"       BOOLEAN NOT NULL DEFAULT false,
    "invitationToken"       VARCHAR(255),
    "invitationExpiresAt"   TIMESTAMP WITH TIME ZONE,
    "invitedBy"             VARCHAR(255),
    "profileImageUrl"       VARCHAR(500),
    "phoneNumber"           VARCHAR(50),
    "preferredLanguage"     VARCHAR(10) DEFAULT 'en',
    "mfaEnabled"            BOOLEAN NOT NULL DEFAULT false,
    "mfaSecret"             VARCHAR(255),
    "lastLoginAt"           TIMESTAMP WITH TIME ZONE,
    "lastLoginIp"           VARCHAR(45),
    "passwordResetToken"    VARCHAR(255),
    "passwordResetExpires"  TIMESTAMP WITH TIME ZONE,
    "failedLoginAttempts"   INTEGER NOT NULL DEFAULT 0,
    "lockedUntil"           TIMESTAMP WITH TIME ZONE,
    "createdAt"             TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    "updatedAt"             TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    CONSTRAINT "UQ_users_email" UNIQUE (email)
);

CREATE INDEX IF NOT EXISTS "IDX_users_email" ON auth.users (email);
CREATE INDEX IF NOT EXISTS "IDX_users_tenantId" ON auth.users ("tenantId");
CREATE INDEX IF NOT EXISTS "IDX_users_role" ON auth.users (role);

-- =============================================================================
-- auth.invitations — owned by auth-service
-- =============================================================================
CREATE TABLE IF NOT EXISTS auth.invitations (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    token               VARCHAR(255) NOT NULL,
    email               VARCHAR(255) NOT NULL,
    "firstName"         VARCHAR(100),
    "lastName"          VARCHAR(100),
    role                VARCHAR(50) NOT NULL DEFAULT 'MODULE_USER',
    "tenantId"          UUID,
    "moduleIds"         JSONB,
    "primaryModuleId"   UUID,
    status              VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    "expiresAt"         TIMESTAMP WITH TIME ZONE NOT NULL,
    "acceptedAt"        TIMESTAMP WITH TIME ZONE,
    "userId"            UUID,
    message             TEXT,
    "invitedBy"         VARCHAR(255),
    "sendCount"         INTEGER NOT NULL DEFAULT 0,
    "lastSentAt"        TIMESTAMP WITH TIME ZONE,
    "acceptedFromIp"    VARCHAR(45),
    "createdAt"         TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    "updatedAt"         TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    CONSTRAINT "UQ_invitations_token" UNIQUE (token)
);

CREATE INDEX IF NOT EXISTS "IDX_invitations_token" ON auth.invitations (token);
CREATE INDEX IF NOT EXISTS "IDX_invitations_email" ON auth.invitations (email);
CREATE INDEX IF NOT EXISTS "IDX_invitations_tenantId" ON auth.invitations ("tenantId");

-- =============================================================================
-- auth.tenant_modules — owned by auth-service
-- =============================================================================
CREATE TABLE IF NOT EXISTS auth.tenant_modules (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    "tenantId"          UUID NOT NULL REFERENCES auth.tenants(id) ON DELETE CASCADE,
    "moduleId"          UUID NOT NULL,
    "isEnabled"         BOOLEAN NOT NULL DEFAULT true,
    configuration       JSONB,
    "maxModuleUsers"    INTEGER,
    "activatedAt"       TIMESTAMP WITH TIME ZONE,
    "expiresAt"         TIMESTAMP WITH TIME ZONE,
    notes               TEXT,
    "assignedBy"        VARCHAR(255),
    "managerId"         UUID,
    "createdAt"         TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    "updatedAt"         TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    CONSTRAINT "UQ_tenant_modules_tenant_module" UNIQUE ("tenantId", "moduleId")
);

CREATE INDEX IF NOT EXISTS "IDX_tenant_modules_tenantId" ON auth.tenant_modules ("tenantId");
CREATE INDEX IF NOT EXISTS "IDX_tenant_modules_moduleId" ON auth.tenant_modules ("moduleId");

-- =============================================================================
-- auth.tenant_roles — used by admin-api-service for RBAC
-- =============================================================================
CREATE TABLE IF NOT EXISTS auth.tenant_roles (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "tenantId"          UUID NOT NULL REFERENCES auth.tenants(id) ON DELETE CASCADE,
    code                VARCHAR(50) NOT NULL,
    name                VARCHAR(100) NOT NULL,
    description         TEXT,
    permissions         JSONB NOT NULL DEFAULT '[]',
    is_default          BOOLEAN NOT NULL DEFAULT false,
    is_editable         BOOLEAN NOT NULL DEFAULT true,
    display_order       INTEGER NOT NULL DEFAULT 0,
    created_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    CONSTRAINT "UQ_tenant_roles_tenant_code" UNIQUE ("tenantId", code)
);

CREATE INDEX IF NOT EXISTS "IDX_tenant_roles_tenantId" ON auth.tenant_roles ("tenantId");
CREATE INDEX IF NOT EXISTS "IDX_tenant_roles_code" ON auth.tenant_roles (code);

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

-- Log completion
DO $$
BEGIN
    RAISE NOTICE 'Database initialization completed. Auth schema tables and indexes created.';
    RAISE NOTICE 'SUPER_ADMIN user will be seeded by auth-service on first startup.';
END $$;
