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
-- Schema ownership (optional - for stricter isolation)
-- Uncomment these if using separate database users per service
-- ============================================================================

-- ALTER SCHEMA auth OWNER TO auth_service_user;
-- ALTER SCHEMA billing OWNER TO billing_service_user;
-- ALTER SCHEMA farm OWNER TO farm_service_user;
-- ALTER SCHEMA sensor OWNER TO sensor_service_user;
-- ALTER SCHEMA admin OWNER TO admin_service_user;

-- ============================================================================
-- Verification query
-- ============================================================================

SELECT nspname AS schema_name,
       pg_catalog.pg_get_userbyid(nspowner) AS owner
FROM pg_catalog.pg_namespace
WHERE nspname NOT LIKE 'pg_%'
  AND nspname NOT IN ('information_schema')
ORDER BY nspname;
