-- =============================================================================
-- Aquaculture Platform - Database Initialization
-- Basic setup - tables are created by TypeORM synchronize
-- =============================================================================

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- Grant permissions
GRANT ALL PRIVILEGES ON DATABASE aquaculture TO aquaculture;

-- Log completion
DO $$
BEGIN
    RAISE NOTICE 'Database initialization completed. Tables will be created by TypeORM.';
END $$;
