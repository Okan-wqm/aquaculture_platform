-- ============================================================================
-- Schema Separation for Aquaculture Platform
--
-- Each microservice owns its own schema for data isolation.
-- This script creates all schemas and grants appropriate permissions.
-- Run this before starting services.
-- ============================================================================

-- ============================================================================
-- TimescaleDB Extension
-- Enables time-series optimization for sensor data
-- ============================================================================
CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE;

-- Verify extension is installed
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
        RAISE NOTICE 'TimescaleDB extension installed successfully';
    ELSE
        RAISE WARNING 'TimescaleDB extension could not be installed';
    END IF;
END
$$;

-- ============================================================================
-- Schema Creation
-- ============================================================================

-- Create schemas for each service
CREATE SCHEMA IF NOT EXISTS auth;      -- auth-service: users, tenants, authentication
CREATE SCHEMA IF NOT EXISTS billing;   -- billing-service: subscriptions, invoices, payments
CREATE SCHEMA IF NOT EXISTS farm;      -- farm-service: farms, tanks, batches, harvests
CREATE SCHEMA IF NOT EXISTS sensor;    -- sensor-service: sensors, readings, alerts
CREATE SCHEMA IF NOT EXISTS admin;     -- admin-api-service: analytics, system settings
CREATE SCHEMA IF NOT EXISTS alert;     -- alert-engine: alert rules, incidents
CREATE SCHEMA IF NOT EXISTS hr;        -- hr-service: employees, departments
CREATE SCHEMA IF NOT EXISTS gateway;   -- gateway-api: rate limits, audit logs

-- Keep public schema for shared/common tables
-- (Note: Consider deprecating in favor of explicit schema assignment)

-- Grant usage on all schemas to the application user
-- In production, use a more restrictive approach with separate users per service
GRANT USAGE ON SCHEMA auth TO aquaculture;
GRANT USAGE ON SCHEMA billing TO aquaculture;
GRANT USAGE ON SCHEMA farm TO aquaculture;
GRANT USAGE ON SCHEMA sensor TO aquaculture;
GRANT USAGE ON SCHEMA admin TO aquaculture;
GRANT USAGE ON SCHEMA alert TO aquaculture;
GRANT USAGE ON SCHEMA hr TO aquaculture;
GRANT USAGE ON SCHEMA gateway TO aquaculture;

-- Grant all privileges on tables in each schema
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA auth TO aquaculture;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA billing TO aquaculture;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA farm TO aquaculture;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA sensor TO aquaculture;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA admin TO aquaculture;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA alert TO aquaculture;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA hr TO aquaculture;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA gateway TO aquaculture;

-- Grant sequence privileges (needed for auto-increment)
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA auth TO aquaculture;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA billing TO aquaculture;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA farm TO aquaculture;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA sensor TO aquaculture;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA admin TO aquaculture;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA alert TO aquaculture;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA hr TO aquaculture;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA gateway TO aquaculture;

-- Set default privileges for future tables
ALTER DEFAULT PRIVILEGES IN SCHEMA auth GRANT ALL ON TABLES TO aquaculture;
ALTER DEFAULT PRIVILEGES IN SCHEMA billing GRANT ALL ON TABLES TO aquaculture;
ALTER DEFAULT PRIVILEGES IN SCHEMA farm GRANT ALL ON TABLES TO aquaculture;
ALTER DEFAULT PRIVILEGES IN SCHEMA sensor GRANT ALL ON TABLES TO aquaculture;
ALTER DEFAULT PRIVILEGES IN SCHEMA admin GRANT ALL ON TABLES TO aquaculture;
ALTER DEFAULT PRIVILEGES IN SCHEMA alert GRANT ALL ON TABLES TO aquaculture;
ALTER DEFAULT PRIVILEGES IN SCHEMA hr GRANT ALL ON TABLES TO aquaculture;
ALTER DEFAULT PRIVILEGES IN SCHEMA gateway GRANT ALL ON TABLES TO aquaculture;

ALTER DEFAULT PRIVILEGES IN SCHEMA auth GRANT ALL ON SEQUENCES TO aquaculture;
ALTER DEFAULT PRIVILEGES IN SCHEMA billing GRANT ALL ON SEQUENCES TO aquaculture;
ALTER DEFAULT PRIVILEGES IN SCHEMA farm GRANT ALL ON SEQUENCES TO aquaculture;
ALTER DEFAULT PRIVILEGES IN SCHEMA sensor GRANT ALL ON SEQUENCES TO aquaculture;
ALTER DEFAULT PRIVILEGES IN SCHEMA admin GRANT ALL ON SEQUENCES TO aquaculture;
ALTER DEFAULT PRIVILEGES IN SCHEMA alert GRANT ALL ON SEQUENCES TO aquaculture;
ALTER DEFAULT PRIVILEGES IN SCHEMA hr GRANT ALL ON SEQUENCES TO aquaculture;
ALTER DEFAULT PRIVILEGES IN SCHEMA gateway GRANT ALL ON SEQUENCES TO aquaculture;

-- ============================================================================
-- Cross-schema read access for analytics
-- admin-api-service needs to read from auth and billing for analytics queries
-- ============================================================================

-- Grant read-only access to auth schema from admin
GRANT SELECT ON ALL TABLES IN SCHEMA auth TO aquaculture;
ALTER DEFAULT PRIVILEGES IN SCHEMA auth GRANT SELECT ON TABLES TO aquaculture;

-- Grant read-only access to billing schema from admin
GRANT SELECT ON ALL TABLES IN SCHEMA billing TO aquaculture;
ALTER DEFAULT PRIVILEGES IN SCHEMA billing GRANT SELECT ON TABLES TO aquaculture;

-- ============================================================================
-- Per-service database users (principle of least privilege)
-- Each service user has access only to its own schema.
-- The shared 'aquaculture' user is kept for backwards compatibility with
-- the development compose but should NOT be used in production.
-- ============================================================================

-- Create per-service users (passwords sourced from env at init time via
-- the POSTGRES_INITDB_ARGS mechanism or set manually after provisioning)
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'auth_service') THEN
    CREATE ROLE auth_service WITH LOGIN PASSWORD 'CHANGE_ME_AUTH_SERVICE_PASS';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'farm_service') THEN
    CREATE ROLE farm_service WITH LOGIN PASSWORD 'CHANGE_ME_FARM_SERVICE_PASS';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'sensor_service') THEN
    CREATE ROLE sensor_service WITH LOGIN PASSWORD 'CHANGE_ME_SENSOR_SERVICE_PASS';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'billing_service') THEN
    CREATE ROLE billing_service WITH LOGIN PASSWORD 'CHANGE_ME_BILLING_SERVICE_PASS';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'hr_service') THEN
    CREATE ROLE hr_service WITH LOGIN PASSWORD 'CHANGE_ME_HR_SERVICE_PASS';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'alert_service') THEN
    CREATE ROLE alert_service WITH LOGIN PASSWORD 'CHANGE_ME_ALERT_SERVICE_PASS';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'admin_service') THEN
    CREATE ROLE admin_service WITH LOGIN PASSWORD 'CHANGE_ME_ADMIN_SERVICE_PASS';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'gateway_service') THEN
    CREATE ROLE gateway_service WITH LOGIN PASSWORD 'CHANGE_ME_GATEWAY_SERVICE_PASS';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'notification_service') THEN
    CREATE ROLE notification_service WITH LOGIN PASSWORD 'CHANGE_ME_NOTIFICATION_SERVICE_PASS';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'hydroponics_service') THEN
    CREATE ROLE hydroponics_service WITH LOGIN PASSWORD 'CHANGE_ME_HYDROPONICS_SERVICE_PASS';
  END IF;
END
$$;

-- Grant each service user access only to its own schema
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

-- notification_service needs access to public schema for shared tables
GRANT USAGE ON SCHEMA public TO notification_service;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO notification_service;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO notification_service;

-- hydroponics_service
GRANT CREATE ON DATABASE aquaculture TO hydroponics_service;
GRANT USAGE ON SCHEMA public TO hydroponics_service;

-- ============================================================================
-- Verification query
-- ============================================================================

SELECT nspname AS schema_name,
       pg_catalog.pg_get_userbyid(nspowner) AS owner
FROM pg_catalog.pg_namespace
WHERE nspname NOT LIKE 'pg_%'
  AND nspname NOT IN ('information_schema')
ORDER BY nspname;
