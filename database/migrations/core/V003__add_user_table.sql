-- V003: Create users table in auth schema
-- Source-of-truth for user accounts with RBAC.
-- Entity: apps/auth-service/src/modules/authentication/entities/user.entity.ts

CREATE TABLE IF NOT EXISTS auth.users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) NOT NULL,
  password VARCHAR(255),
  first_name VARCHAR(100),
  last_name VARCHAR(100),
  role VARCHAR(50) NOT NULL DEFAULT 'MODULE_USER',
  tenant_id UUID REFERENCES auth.tenants(id) ON DELETE CASCADE,
  access_type VARCHAR(20) DEFAULT 'BOTH',
  is_active BOOLEAN NOT NULL DEFAULT true,
  is_email_verified BOOLEAN NOT NULL DEFAULT false,

  -- Invitation
  invitation_token VARCHAR(128),
  invitation_expires_at TIMESTAMPTZ,
  invited_by UUID,

  -- Profile
  profile_image_url VARCHAR(500),
  phone_number VARCHAR(20),
  preferred_language VARCHAR(10) DEFAULT 'tr',
  notification_preferences JSONB,

  -- MFA
  mfa_enabled BOOLEAN NOT NULL DEFAULT false,
  mfa_secret VARCHAR(512),
  mfa_recovery_codes TEXT,
  mfa_failed_attempts INT NOT NULL DEFAULT 0,
  mfa_locked_until TIMESTAMPTZ,

  -- Login tracking
  last_login_at TIMESTAMPTZ,
  last_login_ip VARCHAR(50),
  password_reset_token VARCHAR(128),
  password_reset_expires TIMESTAMPTZ,
  failed_login_attempts INT NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,

  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Indexes ──
CREATE INDEX IF NOT EXISTS "IDX_users_tenant" ON auth.users (tenant_id);
CREATE INDEX IF NOT EXISTS "IDX_users_role" ON auth.users (role);
CREATE UNIQUE INDEX IF NOT EXISTS "IDX_users_invitation_token"
  ON auth.users (invitation_token) WHERE invitation_token IS NOT NULL;
CREATE INDEX IF NOT EXISTS "IDX_users_password_reset_token"
  ON auth.users (password_reset_token) WHERE password_reset_token IS NOT NULL;
-- Case-insensitive email uniqueness
CREATE UNIQUE INDEX IF NOT EXISTS "IDX_users_email_lower"
  ON auth.users (LOWER(email));
