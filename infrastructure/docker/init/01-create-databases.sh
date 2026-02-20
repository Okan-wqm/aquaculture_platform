#!/bin/bash
set -e

# Create additional databases needed by services
# This script runs automatically on first postgres start via /docker-entrypoint-initdb.d/

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    SELECT 'CREATE DATABASE aquaculture_observability'
    WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'aquaculture_observability')\gexec
EOSQL
