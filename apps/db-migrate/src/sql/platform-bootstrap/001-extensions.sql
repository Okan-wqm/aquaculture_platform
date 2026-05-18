-- ============================================================================
-- Platform Bootstrap — Stage 1 of 7: PostgreSQL Extensions
--
-- Idempotent install of every cluster-level extension the platform depends on.
-- This file runs in EVERY aqua-db-migrate invocation (Phase 0), so it survives
-- DROP SCHEMA + container restart cycles. Previously lived in
-- infrastructure/docker/init-scripts/00-init-schemas.sh, which only ran on
-- initdb (empty PGDATA) and could not be re-applied without manual psql.
--
-- Extension purpose map (preserved verbatim from 00-init-schemas.sh):
--   timescaledb — sensor_readings + readings_aggregates hypertables
--                 (apps/sensor-service)
--   uuid-ossp   — uuid_generate_v4() in legacy farm migrations
--                 (apps/farm-service); newer code uses gen_random_uuid()
--                 from pgcrypto
--   pg_trgm     — trigram indexes for fuzzy name search
--   btree_gist  — temporal-range EXCLUDE constraints (scheduling)
--   pgcrypto    — gen_random_uuid() + crypt() (auth password helpers)
--   vector      — pgvector embeddings (apps/ai-service + messaging-service AI)
--
-- ADR-031: every platform DDL contract is idempotent + restart-survive.
-- ============================================================================
CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;

-- Post-install verification — RAISE EXCEPTION if any critical platform
-- extension failed to install. TimescaleDB is the only one that can
-- genuinely fail (Docker image variant); the others ship with every
-- PostgreSQL distribution.
DO $$
DECLARE
  ext_name TEXT;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
    RAISE NOTICE '[platform-bootstrap] TimescaleDB extension OK';
  ELSE
    RAISE EXCEPTION '[platform-bootstrap] TimescaleDB extension MISSING — sensor-service migrations will fail';
  END IF;

  FOREACH ext_name IN ARRAY ARRAY['uuid-ossp','pg_trgm','btree_gist','pgcrypto','vector']::text[]
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = ext_name) THEN
      RAISE EXCEPTION '[platform-bootstrap] Platform extension % MISSING — refusing to proceed', ext_name;
    END IF;
  END LOOP;
END
$$;
