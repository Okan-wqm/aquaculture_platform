# Messaging vector dimension clone drift

Date: 2026-05-02

## Problem

Messaging E2E failed while creating the HNSW index on `messages.embedding`:

`column does not have dimensions`

## Impact

Tenant schemas with a dimensionless pgvector column cannot create the
`vector_cosine_ops` HNSW index. That blocks service bootstrap and prevents the
tenant schema from reaching the same searchable message shape as the source
schema.

## Root Cause

The E2E partitioned-table clone helper read column types through
`information_schema.columns`. For pgvector, that path returns only the base
`vector` type and loses the typmod from `vector(384)`.

The migration also assumed an existing `embedding` column already had the
correct dimension.

## Fix

The E2E clone helper now reads column DDL through `pg_attribute` +
`format_type`, matching the production tenant schema sync pattern and
preserving `vector(384)`.

The AI migration now normalizes any existing dimensionless `messages.embedding`
column to `vector(384)` before creating the HNSW index. If non-null vectors
with another dimension exist, the migration fails loudly instead of corrupting
semantic-search data.

## Verification

The next messaging E2E CI run should pass the AI migration bootstrap phase for
tenant schemas and reach the actual domain tests.
