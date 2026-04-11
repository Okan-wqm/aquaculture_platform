-- V001: Initial core schema setup
-- Creates the auth schema and extension prerequisites for the platform.
-- All core platform tables (tenants, users, etc.) live in the auth schema.

-- ============================================================================
-- 1. Extensions
-- ============================================================================
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================================
-- 2. Auth schema
-- ============================================================================
CREATE SCHEMA IF NOT EXISTS auth;
