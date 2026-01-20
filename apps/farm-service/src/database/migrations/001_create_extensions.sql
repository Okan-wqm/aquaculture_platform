-- Migration: 001_create_extensions
-- Description: PostgreSQL extensions for farm module
-- Date: 2024-11-29

-- UUID generation
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Full-text search optimization
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- Range types and constraints (for scheduling, overlaps)
CREATE EXTENSION IF NOT EXISTS "btree_gist";
