#!/bin/bash
# ============================================================================
# Schema Separation for Aquaculture Platform
#
# Each microservice owns its own schema for data isolation.
# This script creates all schemas and grants appropriate permissions.
# Run this before starting services.
#
# SEC-015: Service passwords are read from environment variables.
# If a variable is not set, a cryptographically random 32-byte password is
# generated automatically so that hardcoded credentials never reach the DB.
# ============================================================================
set -euo pipefail

# ============================================================================
# Generate secure passwords from env vars (fall back to random)
# ============================================================================
generate_pass() {
  openssl rand -base64 32 | tr -d '\n'
}

# Escape single quotes for safe embedding in SQL PASSWORD '...' literals
escape_sql() {
  printf '%s' "$1" | sed "s/'/''/g"
}

AUTH_PASS="$(escape_sql "${AUTH_SERVICE_DB_PASS:-$(generate_pass)}")"
FARM_PASS="$(escape_sql "${FARM_SERVICE_DB_PASS:-$(generate_pass)}")"
SENSOR_PASS="$(escape_sql "${SENSOR_SERVICE_DB_PASS:-$(generate_pass)}")"
BILLING_PASS="$(escape_sql "${BILLING_SERVICE_DB_PASS:-$(generate_pass)}")"
HR_PASS="$(escape_sql "${HR_SERVICE_DB_PASS:-$(generate_pass)}")"
ALERT_PASS="$(escape_sql "${ALERT_SERVICE_DB_PASS:-$(generate_pass)}")"
ADMIN_PASS="$(escape_sql "${ADMIN_SERVICE_DB_PASS:-$(generate_pass)}")"
GATEWAY_PASS="$(escape_sql "${GATEWAY_SERVICE_DB_PASS:-$(generate_pass)}")"
NOTIFICATION_PASS="$(escape_sql "${NOTIFICATION_SERVICE_DB_PASS:-$(generate_pass)}")"
HYDROPONICS_PASS="$(escape_sql "${HYDROPONICS_SERVICE_DB_PASS:-$(generate_pass)}")"
AI_PASS="$(escape_sql "${AI_SERVICE_DB_PASS:-$(generate_pass)}")"
MESSAGING_PASS="$(escape_sql "${MESSAGING_SERVICE_DB_PASS:-$(generate_pass)}")"
OBSERVABILITY_PASS="$(escape_sql "${OBSERVABILITY_SERVICE_DB_PASS:-$(generate_pass)}")"
EVENT_STORE_PASS="$(escape_sql "${EVENT_STORE_SERVICE_DB_PASS:-$(generate_pass)}")"

# Log which passwords came from env vs generated (without revealing values)
for var_name in AUTH_SERVICE_DB_PASS FARM_SERVICE_DB_PASS SENSOR_SERVICE_DB_PASS \
  BILLING_SERVICE_DB_PASS HR_SERVICE_DB_PASS ALERT_SERVICE_DB_PASS \
  ADMIN_SERVICE_DB_PASS GATEWAY_SERVICE_DB_PASS NOTIFICATION_SERVICE_DB_PASS \
  HYDROPONICS_SERVICE_DB_PASS AI_SERVICE_DB_PASS MESSAGING_SERVICE_DB_PASS \
  OBSERVABILITY_SERVICE_DB_PASS EVENT_STORE_SERVICE_DB_PASS; do
  if [ -n "${!var_name:-}" ]; then
    echo "[init-schemas] $var_name: using provided value"
  else
    echo "[init-schemas] $var_name: not set — generated random password"
  fi
done

# ============================================================================
# Execute SQL via psql
# ============================================================================
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL

  -- ========================================================================
  -- TimescaleDB Extension
  -- Enables time-series optimization for sensor data
  -- ========================================================================
  CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE;

  -- Verify extension is installed
  DO \$\$
  BEGIN
      IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
          RAISE NOTICE 'TimescaleDB extension installed successfully';
      ELSE
          RAISE WARNING 'TimescaleDB extension could not be installed';
      END IF;
  END
  \$\$;

  -- ========================================================================
  -- Per-Service Roles (created BEFORE schemas for AUTHORIZATION clause)
  --
  -- WHY roles first: CREATE SCHEMA ... AUTHORIZATION requires the role to
  -- exist. By creating roles before schemas, we can set correct ownership
  -- from birth — no retroactive ALTER OWNER needed for new databases.
  -- ========================================================================
  DO \$\$
  BEGIN
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'auth_service') THEN
      CREATE ROLE auth_service WITH LOGIN PASSWORD '${AUTH_PASS}';
    END IF;
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'farm_service') THEN
      CREATE ROLE farm_service WITH LOGIN PASSWORD '${FARM_PASS}';
    END IF;
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'sensor_service') THEN
      CREATE ROLE sensor_service WITH LOGIN PASSWORD '${SENSOR_PASS}';
    END IF;
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'billing_service') THEN
      CREATE ROLE billing_service WITH LOGIN PASSWORD '${BILLING_PASS}';
    END IF;
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'hr_service') THEN
      CREATE ROLE hr_service WITH LOGIN PASSWORD '${HR_PASS}';
    END IF;
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'alert_service') THEN
      CREATE ROLE alert_service WITH LOGIN PASSWORD '${ALERT_PASS}';
    END IF;
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'admin_service') THEN
      CREATE ROLE admin_service WITH LOGIN PASSWORD '${ADMIN_PASS}';
    END IF;
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'gateway_service') THEN
      CREATE ROLE gateway_service WITH LOGIN PASSWORD '${GATEWAY_PASS}';
    END IF;
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'notification_service') THEN
      CREATE ROLE notification_service WITH LOGIN PASSWORD '${NOTIFICATION_PASS}';
    END IF;
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'hydroponics_service') THEN
      CREATE ROLE hydroponics_service WITH LOGIN PASSWORD '${HYDROPONICS_PASS}';
    END IF;
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'ai_service') THEN
      CREATE ROLE ai_service WITH LOGIN PASSWORD '${AI_PASS}';
    END IF;
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'messaging_service') THEN
      CREATE ROLE messaging_service WITH LOGIN PASSWORD '${MESSAGING_PASS}';
    END IF;
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'observability_service') THEN
      CREATE ROLE observability_service WITH LOGIN PASSWORD '${OBSERVABILITY_PASS}';
    END IF;
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'event_store_service') THEN
      CREATE ROLE event_store_service WITH LOGIN PASSWORD '${EVENT_STORE_PASS}';
    END IF;
  END
  \$\$;

  -- ========================================================================
  -- Schema Creation with Correct Ownership
  --
  -- AUTHORIZATION sets the schema owner at creation time. Tables created
  -- inside the schema by the owner role inherit the correct ownership
  -- automatically — no retroactive ALTER OWNER needed.
  --
  -- ALTER SCHEMA OWNER TO handles the idempotent case: if the schema
  -- already exists from a previous init (IF NOT EXISTS skips AUTHORIZATION),
  -- the ALTER ensures ownership is correct regardless.
  -- ========================================================================

  # BEGIN GENERATED — schema-registry
  -- Source: apps/db-migrate/src/schema-registry.ts
  -- Regenerate with: npm run codegen:schema-registry

  -- Create schemas owned by their service roles
  CREATE SCHEMA IF NOT EXISTS auth AUTHORIZATION auth_service;
  CREATE SCHEMA IF NOT EXISTS farm AUTHORIZATION farm_service;
  CREATE SCHEMA IF NOT EXISTS sensor AUTHORIZATION sensor_service;
  CREATE SCHEMA IF NOT EXISTS hr AUTHORIZATION hr_service;
  CREATE SCHEMA IF NOT EXISTS messaging AUTHORIZATION messaging_service;
  CREATE SCHEMA IF NOT EXISTS hydroponics AUTHORIZATION hydroponics_service;
  CREATE SCHEMA IF NOT EXISTS alert AUTHORIZATION alert_service;
  CREATE SCHEMA IF NOT EXISTS billing AUTHORIZATION billing_service;
  CREATE SCHEMA IF NOT EXISTS notification AUTHORIZATION notification_service;
  CREATE SCHEMA IF NOT EXISTS ai AUTHORIZATION ai_service;
  CREATE SCHEMA IF NOT EXISTS admin AUTHORIZATION admin_service;
  CREATE SCHEMA IF NOT EXISTS observability AUTHORIZATION observability_service;
  CREATE SCHEMA IF NOT EXISTS event_store AUTHORIZATION event_store_service;

  -- Idempotent ownership fix: ALTER OWNER ensures correct owner even
  -- when the schema already existed before this init ran (IF NOT
  -- EXISTS skips the AUTHORIZATION clause in that case).
  ALTER SCHEMA auth OWNER TO auth_service;
  ALTER SCHEMA farm OWNER TO farm_service;
  ALTER SCHEMA sensor OWNER TO sensor_service;
  ALTER SCHEMA hr OWNER TO hr_service;
  ALTER SCHEMA messaging OWNER TO messaging_service;
  ALTER SCHEMA hydroponics OWNER TO hydroponics_service;
  ALTER SCHEMA alert OWNER TO alert_service;
  ALTER SCHEMA billing OWNER TO billing_service;
  ALTER SCHEMA notification OWNER TO notification_service;
  ALTER SCHEMA ai OWNER TO ai_service;
  ALTER SCHEMA admin OWNER TO admin_service;
  ALTER SCHEMA observability OWNER TO observability_service;
  ALTER SCHEMA event_store OWNER TO event_store_service;

  -- Shared POSTGRES_USER access (backward compat — services still
  -- connect as POSTGRES_USER in some paths until full role cutover).
  GRANT USAGE ON SCHEMA auth TO ${POSTGRES_USER};
  GRANT USAGE ON SCHEMA farm TO ${POSTGRES_USER};
  GRANT USAGE ON SCHEMA sensor TO ${POSTGRES_USER};
  GRANT USAGE ON SCHEMA hr TO ${POSTGRES_USER};
  GRANT USAGE ON SCHEMA messaging TO ${POSTGRES_USER};
  GRANT USAGE ON SCHEMA hydroponics TO ${POSTGRES_USER};
  GRANT USAGE ON SCHEMA alert TO ${POSTGRES_USER};
  GRANT USAGE ON SCHEMA billing TO ${POSTGRES_USER};
  GRANT USAGE ON SCHEMA notification TO ${POSTGRES_USER};
  GRANT USAGE ON SCHEMA ai TO ${POSTGRES_USER};
  GRANT USAGE ON SCHEMA admin TO ${POSTGRES_USER};
  GRANT USAGE ON SCHEMA observability TO ${POSTGRES_USER};
  GRANT USAGE ON SCHEMA event_store TO ${POSTGRES_USER};

  GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA auth TO ${POSTGRES_USER};
  GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA farm TO ${POSTGRES_USER};
  GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA sensor TO ${POSTGRES_USER};
  GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA hr TO ${POSTGRES_USER};
  GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA messaging TO ${POSTGRES_USER};
  GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA hydroponics TO ${POSTGRES_USER};
  GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA alert TO ${POSTGRES_USER};
  GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA billing TO ${POSTGRES_USER};
  GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA notification TO ${POSTGRES_USER};
  GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA ai TO ${POSTGRES_USER};
  GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA admin TO ${POSTGRES_USER};
  GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA observability TO ${POSTGRES_USER};
  GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA event_store TO ${POSTGRES_USER};

  GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA auth TO ${POSTGRES_USER};
  GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA farm TO ${POSTGRES_USER};
  GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA sensor TO ${POSTGRES_USER};
  GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA hr TO ${POSTGRES_USER};
  GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA messaging TO ${POSTGRES_USER};
  GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA hydroponics TO ${POSTGRES_USER};
  GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA alert TO ${POSTGRES_USER};
  GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA billing TO ${POSTGRES_USER};
  GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA notification TO ${POSTGRES_USER};
  GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA ai TO ${POSTGRES_USER};
  GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA admin TO ${POSTGRES_USER};
  GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA observability TO ${POSTGRES_USER};
  GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA event_store TO ${POSTGRES_USER};

  -- Default privileges for future objects in each schema
  ALTER DEFAULT PRIVILEGES IN SCHEMA auth GRANT ALL ON TABLES TO ${POSTGRES_USER};
  ALTER DEFAULT PRIVILEGES IN SCHEMA farm GRANT ALL ON TABLES TO ${POSTGRES_USER};
  ALTER DEFAULT PRIVILEGES IN SCHEMA sensor GRANT ALL ON TABLES TO ${POSTGRES_USER};
  ALTER DEFAULT PRIVILEGES IN SCHEMA hr GRANT ALL ON TABLES TO ${POSTGRES_USER};
  ALTER DEFAULT PRIVILEGES IN SCHEMA messaging GRANT ALL ON TABLES TO ${POSTGRES_USER};
  ALTER DEFAULT PRIVILEGES IN SCHEMA hydroponics GRANT ALL ON TABLES TO ${POSTGRES_USER};
  ALTER DEFAULT PRIVILEGES IN SCHEMA alert GRANT ALL ON TABLES TO ${POSTGRES_USER};
  ALTER DEFAULT PRIVILEGES IN SCHEMA billing GRANT ALL ON TABLES TO ${POSTGRES_USER};
  ALTER DEFAULT PRIVILEGES IN SCHEMA notification GRANT ALL ON TABLES TO ${POSTGRES_USER};
  ALTER DEFAULT PRIVILEGES IN SCHEMA ai GRANT ALL ON TABLES TO ${POSTGRES_USER};
  ALTER DEFAULT PRIVILEGES IN SCHEMA admin GRANT ALL ON TABLES TO ${POSTGRES_USER};
  ALTER DEFAULT PRIVILEGES IN SCHEMA observability GRANT ALL ON TABLES TO ${POSTGRES_USER};
  ALTER DEFAULT PRIVILEGES IN SCHEMA event_store GRANT ALL ON TABLES TO ${POSTGRES_USER};

  ALTER DEFAULT PRIVILEGES IN SCHEMA auth GRANT ALL ON SEQUENCES TO ${POSTGRES_USER};
  ALTER DEFAULT PRIVILEGES IN SCHEMA farm GRANT ALL ON SEQUENCES TO ${POSTGRES_USER};
  ALTER DEFAULT PRIVILEGES IN SCHEMA sensor GRANT ALL ON SEQUENCES TO ${POSTGRES_USER};
  ALTER DEFAULT PRIVILEGES IN SCHEMA hr GRANT ALL ON SEQUENCES TO ${POSTGRES_USER};
  ALTER DEFAULT PRIVILEGES IN SCHEMA messaging GRANT ALL ON SEQUENCES TO ${POSTGRES_USER};
  ALTER DEFAULT PRIVILEGES IN SCHEMA hydroponics GRANT ALL ON SEQUENCES TO ${POSTGRES_USER};
  ALTER DEFAULT PRIVILEGES IN SCHEMA alert GRANT ALL ON SEQUENCES TO ${POSTGRES_USER};
  ALTER DEFAULT PRIVILEGES IN SCHEMA billing GRANT ALL ON SEQUENCES TO ${POSTGRES_USER};
  ALTER DEFAULT PRIVILEGES IN SCHEMA notification GRANT ALL ON SEQUENCES TO ${POSTGRES_USER};
  ALTER DEFAULT PRIVILEGES IN SCHEMA ai GRANT ALL ON SEQUENCES TO ${POSTGRES_USER};
  ALTER DEFAULT PRIVILEGES IN SCHEMA admin GRANT ALL ON SEQUENCES TO ${POSTGRES_USER};
  ALTER DEFAULT PRIVILEGES IN SCHEMA observability GRANT ALL ON SEQUENCES TO ${POSTGRES_USER};
  ALTER DEFAULT PRIVILEGES IN SCHEMA event_store GRANT ALL ON SEQUENCES TO ${POSTGRES_USER};
  # END GENERATED — schema-registry

  -- gateway-api is stateless today but reserves a `gateway` schema for
  -- future cached-config storage. Not in SCHEMA_REGISTRY — kept here
  -- hand-written so the codegen doesn't try to own it.
  CREATE SCHEMA IF NOT EXISTS gateway AUTHORIZATION gateway_service;
  ALTER SCHEMA gateway OWNER TO gateway_service;
  GRANT USAGE ON SCHEMA gateway TO ${POSTGRES_USER};
  GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA gateway TO ${POSTGRES_USER};
  GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA gateway TO ${POSTGRES_USER};
  ALTER DEFAULT PRIVILEGES IN SCHEMA gateway GRANT ALL ON TABLES TO ${POSTGRES_USER};
  ALTER DEFAULT PRIVILEGES IN SCHEMA gateway GRANT ALL ON SEQUENCES TO ${POSTGRES_USER};

  -- Grant the shared application user access to all schemas (backward compat)
  GRANT USAGE ON SCHEMA auth TO ${POSTGRES_USER};
  GRANT USAGE ON SCHEMA billing TO ${POSTGRES_USER};
  GRANT USAGE ON SCHEMA farm TO ${POSTGRES_USER};
  GRANT USAGE ON SCHEMA sensor TO ${POSTGRES_USER};
  GRANT USAGE ON SCHEMA admin TO ${POSTGRES_USER};
  GRANT USAGE ON SCHEMA alert TO ${POSTGRES_USER};
  GRANT USAGE ON SCHEMA hr TO ${POSTGRES_USER};
  GRANT USAGE ON SCHEMA gateway TO ${POSTGRES_USER};
  GRANT USAGE ON SCHEMA hydroponics TO ${POSTGRES_USER};
  GRANT USAGE ON SCHEMA ai TO ${POSTGRES_USER};
  GRANT USAGE ON SCHEMA messaging TO ${POSTGRES_USER};
  GRANT USAGE ON SCHEMA notification TO ${POSTGRES_USER};

  -- Grant all privileges on tables in each schema
  GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA auth TO ${POSTGRES_USER};
  GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA billing TO ${POSTGRES_USER};
  GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA farm TO ${POSTGRES_USER};
  GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA sensor TO ${POSTGRES_USER};
  GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA admin TO ${POSTGRES_USER};
  GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA alert TO ${POSTGRES_USER};
  GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA hr TO ${POSTGRES_USER};
  GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA gateway TO ${POSTGRES_USER};
  GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA hydroponics TO ${POSTGRES_USER};
  GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA ai TO ${POSTGRES_USER};
  GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA messaging TO ${POSTGRES_USER};
  GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA notification TO ${POSTGRES_USER};

  -- Grant sequence privileges (needed for auto-increment)
  GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA auth TO ${POSTGRES_USER};
  GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA billing TO ${POSTGRES_USER};
  GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA farm TO ${POSTGRES_USER};
  GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA sensor TO ${POSTGRES_USER};
  GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA admin TO ${POSTGRES_USER};
  GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA alert TO ${POSTGRES_USER};
  GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA hr TO ${POSTGRES_USER};
  GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA gateway TO ${POSTGRES_USER};
  GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA hydroponics TO ${POSTGRES_USER};
  GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA ai TO ${POSTGRES_USER};
  GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA messaging TO ${POSTGRES_USER};
  GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA notification TO ${POSTGRES_USER};

  -- Set default privileges for future tables
  ALTER DEFAULT PRIVILEGES IN SCHEMA auth GRANT ALL ON TABLES TO ${POSTGRES_USER};
  ALTER DEFAULT PRIVILEGES IN SCHEMA billing GRANT ALL ON TABLES TO ${POSTGRES_USER};
  ALTER DEFAULT PRIVILEGES IN SCHEMA farm GRANT ALL ON TABLES TO ${POSTGRES_USER};
  ALTER DEFAULT PRIVILEGES IN SCHEMA sensor GRANT ALL ON TABLES TO ${POSTGRES_USER};
  ALTER DEFAULT PRIVILEGES IN SCHEMA admin GRANT ALL ON TABLES TO ${POSTGRES_USER};
  ALTER DEFAULT PRIVILEGES IN SCHEMA alert GRANT ALL ON TABLES TO ${POSTGRES_USER};
  ALTER DEFAULT PRIVILEGES IN SCHEMA hr GRANT ALL ON TABLES TO ${POSTGRES_USER};
  ALTER DEFAULT PRIVILEGES IN SCHEMA gateway GRANT ALL ON TABLES TO ${POSTGRES_USER};
  ALTER DEFAULT PRIVILEGES IN SCHEMA hydroponics GRANT ALL ON TABLES TO ${POSTGRES_USER};
  ALTER DEFAULT PRIVILEGES IN SCHEMA ai GRANT ALL ON TABLES TO ${POSTGRES_USER};
  ALTER DEFAULT PRIVILEGES IN SCHEMA messaging GRANT ALL ON TABLES TO ${POSTGRES_USER};
  ALTER DEFAULT PRIVILEGES IN SCHEMA notification GRANT ALL ON TABLES TO ${POSTGRES_USER};

  ALTER DEFAULT PRIVILEGES IN SCHEMA auth GRANT ALL ON SEQUENCES TO ${POSTGRES_USER};
  ALTER DEFAULT PRIVILEGES IN SCHEMA billing GRANT ALL ON SEQUENCES TO ${POSTGRES_USER};
  ALTER DEFAULT PRIVILEGES IN SCHEMA farm GRANT ALL ON SEQUENCES TO ${POSTGRES_USER};
  ALTER DEFAULT PRIVILEGES IN SCHEMA sensor GRANT ALL ON SEQUENCES TO ${POSTGRES_USER};
  ALTER DEFAULT PRIVILEGES IN SCHEMA admin GRANT ALL ON SEQUENCES TO ${POSTGRES_USER};
  ALTER DEFAULT PRIVILEGES IN SCHEMA alert GRANT ALL ON SEQUENCES TO ${POSTGRES_USER};
  ALTER DEFAULT PRIVILEGES IN SCHEMA hr GRANT ALL ON SEQUENCES TO ${POSTGRES_USER};
  ALTER DEFAULT PRIVILEGES IN SCHEMA gateway GRANT ALL ON SEQUENCES TO ${POSTGRES_USER};
  ALTER DEFAULT PRIVILEGES IN SCHEMA hydroponics GRANT ALL ON SEQUENCES TO ${POSTGRES_USER};
  ALTER DEFAULT PRIVILEGES IN SCHEMA ai GRANT ALL ON SEQUENCES TO ${POSTGRES_USER};
  ALTER DEFAULT PRIVILEGES IN SCHEMA messaging GRANT ALL ON SEQUENCES TO ${POSTGRES_USER};
  ALTER DEFAULT PRIVILEGES IN SCHEMA notification GRANT ALL ON SEQUENCES TO ${POSTGRES_USER};

  -- ========================================================================
  -- Cross-schema read access for analytics
  -- admin-api-service needs to read from auth and billing for analytics queries
  -- ========================================================================

  -- Grant read-only access to auth schema from admin
  GRANT SELECT ON ALL TABLES IN SCHEMA auth TO ${POSTGRES_USER};
  ALTER DEFAULT PRIVILEGES IN SCHEMA auth GRANT SELECT ON TABLES TO ${POSTGRES_USER};

  -- Grant read-only access to billing schema from admin
  GRANT SELECT ON ALL TABLES IN SCHEMA billing TO ${POSTGRES_USER};
  ALTER DEFAULT PRIVILEGES IN SCHEMA billing GRANT SELECT ON TABLES TO ${POSTGRES_USER};

  -- ========================================================================
  -- Per-service schema grants (roles created above, before schema creation)
  -- ========================================================================

  -- Grant each service user full access to its own schema
  GRANT USAGE ON SCHEMA auth TO auth_service;
  GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA auth TO auth_service;
  GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA auth TO auth_service;
  ALTER DEFAULT PRIVILEGES IN SCHEMA auth GRANT ALL ON TABLES TO auth_service;
  ALTER DEFAULT PRIVILEGES IN SCHEMA auth GRANT ALL ON SEQUENCES TO auth_service;

  GRANT USAGE ON SCHEMA farm TO farm_service;
  GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA farm TO farm_service;
  GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA farm TO farm_service;
  ALTER DEFAULT PRIVILEGES IN SCHEMA farm GRANT ALL ON TABLES TO farm_service;
  ALTER DEFAULT PRIVILEGES IN SCHEMA farm GRANT ALL ON SEQUENCES TO farm_service;

  GRANT USAGE ON SCHEMA sensor TO sensor_service;
  GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA sensor TO sensor_service;
  GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA sensor TO sensor_service;
  ALTER DEFAULT PRIVILEGES IN SCHEMA sensor GRANT ALL ON TABLES TO sensor_service;
  ALTER DEFAULT PRIVILEGES IN SCHEMA sensor GRANT ALL ON SEQUENCES TO sensor_service;

  GRANT USAGE ON SCHEMA billing TO billing_service;
  GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA billing TO billing_service;
  GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA billing TO billing_service;
  ALTER DEFAULT PRIVILEGES IN SCHEMA billing GRANT ALL ON TABLES TO billing_service;
  ALTER DEFAULT PRIVILEGES IN SCHEMA billing GRANT ALL ON SEQUENCES TO billing_service;

  GRANT USAGE ON SCHEMA hr TO hr_service;
  GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA hr TO hr_service;
  GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA hr TO hr_service;
  ALTER DEFAULT PRIVILEGES IN SCHEMA hr GRANT ALL ON TABLES TO hr_service;
  ALTER DEFAULT PRIVILEGES IN SCHEMA hr GRANT ALL ON SEQUENCES TO hr_service;

  GRANT USAGE ON SCHEMA alert TO alert_service;
  GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA alert TO alert_service;
  GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA alert TO alert_service;
  ALTER DEFAULT PRIVILEGES IN SCHEMA alert GRANT ALL ON TABLES TO alert_service;
  ALTER DEFAULT PRIVILEGES IN SCHEMA alert GRANT ALL ON SEQUENCES TO alert_service;

  GRANT USAGE ON SCHEMA admin TO admin_service;
  GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA admin TO admin_service;
  GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA admin TO admin_service;
  ALTER DEFAULT PRIVILEGES IN SCHEMA admin GRANT ALL ON TABLES TO admin_service;
  ALTER DEFAULT PRIVILEGES IN SCHEMA admin GRANT ALL ON SEQUENCES TO admin_service;
  -- admin_service also needs read access to auth and billing for analytics
  GRANT USAGE ON SCHEMA auth TO admin_service;
  GRANT SELECT ON ALL TABLES IN SCHEMA auth TO admin_service;
  ALTER DEFAULT PRIVILEGES IN SCHEMA auth GRANT SELECT ON TABLES TO admin_service;
  GRANT USAGE ON SCHEMA billing TO admin_service;
  GRANT SELECT ON ALL TABLES IN SCHEMA billing TO admin_service;
  ALTER DEFAULT PRIVILEGES IN SCHEMA billing GRANT SELECT ON TABLES TO admin_service;

  GRANT USAGE ON SCHEMA gateway TO gateway_service;
  GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA gateway TO gateway_service;
  GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA gateway TO gateway_service;
  ALTER DEFAULT PRIVILEGES IN SCHEMA gateway GRANT ALL ON TABLES TO gateway_service;
  ALTER DEFAULT PRIVILEGES IN SCHEMA gateway GRANT ALL ON SEQUENCES TO gateway_service;

  -- notification_service owns its own schema (device_tokens, notification_logs
  -- land here after Phase 6/7 moves). Public grants retained for the four
  -- cross-service shared tables (audit_logs, gdpr_data_requests, user_consents,
  -- user_permissions) until Phase 9 moves them to the `shared` schema.
  GRANT USAGE ON SCHEMA notification TO notification_service;
  GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA notification TO notification_service;
  GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA notification TO notification_service;
  ALTER DEFAULT PRIVILEGES IN SCHEMA notification GRANT ALL ON TABLES TO notification_service;
  ALTER DEFAULT PRIVILEGES IN SCHEMA notification GRANT ALL ON SEQUENCES TO notification_service;
  GRANT USAGE ON SCHEMA public TO notification_service;
  GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO notification_service;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO notification_service;

  -- hydroponics_service
  GRANT USAGE ON SCHEMA hydroponics TO hydroponics_service;
  GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA hydroponics TO hydroponics_service;
  GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA hydroponics TO hydroponics_service;
  ALTER DEFAULT PRIVILEGES IN SCHEMA hydroponics GRANT ALL ON TABLES TO hydroponics_service;
  ALTER DEFAULT PRIVILEGES IN SCHEMA hydroponics GRANT ALL ON SEQUENCES TO hydroponics_service;
  GRANT CREATE ON DATABASE ${POSTGRES_DB} TO hydroponics_service;
  GRANT USAGE ON SCHEMA public TO hydroponics_service;

  -- ai_service
  GRANT USAGE ON SCHEMA ai TO ai_service;
  GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA ai TO ai_service;
  GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA ai TO ai_service;
  ALTER DEFAULT PRIVILEGES IN SCHEMA ai GRANT ALL ON TABLES TO ai_service;
  ALTER DEFAULT PRIVILEGES IN SCHEMA ai GRANT ALL ON SEQUENCES TO ai_service;

  -- messaging_service
  GRANT USAGE ON SCHEMA messaging TO messaging_service;
  GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA messaging TO messaging_service;
  GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA messaging TO messaging_service;
  ALTER DEFAULT PRIVILEGES IN SCHEMA messaging GRANT ALL ON TABLES TO messaging_service;
  ALTER DEFAULT PRIVILEGES IN SCHEMA messaging GRANT ALL ON SEQUENCES TO messaging_service;
  -- messaging_service needs CREATE on database for tenant schema creation
  GRANT CREATE ON DATABASE ${POSTGRES_DB} TO messaging_service;

  -- ========================================================================
  -- Verification query
  -- ========================================================================
  --
  -- Schema-evolution ALTER TABLE statements that USED to live here have
  -- been removed. They targeted `billing.subscription` (singular) which
  -- never matched the actual entity table name `billing.subscriptions`
  -- (plural — see apps/billing-service/src/billing/entities/subscription.entity.ts:92).
  -- The IF EXISTS guard made every one a silent no-op for as long as the
  -- block existed (a reviewer-trap, flagged HIGH-005 in the 2026-04-14
  -- review).
  --
  -- Schema evolution for billing now goes through the proper TypeORM
  -- migration runner wired in P2b of the public-schema teardown:
  --   apps/billing-service/src/database/migrations/
  -- The first migration (1744400000000-AddPlanSoftDeleteColumns.ts) is
  -- the architectural replacement — it targets the correct table name
  -- and produces tracked migration ledger entries instead of silent ALTERs.
  -- ========================================================================

  SELECT nspname AS schema_name,
         pg_catalog.pg_get_userbyid(nspowner) AS owner
  FROM pg_catalog.pg_namespace
  WHERE nspname NOT LIKE 'pg_%'
    AND nspname NOT IN ('information_schema')
  ORDER BY nspname;

EOSQL

echo "[init-schemas] Database initialization complete."
