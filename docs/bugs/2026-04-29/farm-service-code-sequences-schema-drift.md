# Farm Service Code Sequences Schema Drift

Date: 2026-04-29

## Problem

`CodeGeneratorService` uses the `CodeSequence` entity shape with camelCase
columns (`tenantId`, `entityType`, `lastSequence`). Older bootstrap SQL defined
the same table with snake_case columns (`tenant_id`, `entity_type`,
`last_sequence`). That mismatch can make production code generation fail or
write to a table shape different from the one cloned into tenant schemas.

## Root Fix

Added `AlignCodeSequencesSchema1786900000000`, a TypeScript migration that:

- creates the canonical `farm.code_sequences` table if missing;
- renames legacy snake_case columns to the entity-owned camelCase names;
- aligns timestamp column types to `timestamptz`;
- creates missing tenant `code_sequences` tables from the source table;
- repairs every existing `tenant_*` schema, not only the source schema;
- installs the unique index required by atomic sequence UPSERTs.

This is intentionally database-level. Handlers and tests must not work around a
wrong table contract.

## Verification

- `apps/farm-service/src/__tests__/e2e/code-sequences-schema-alignment.postgres.spec.ts`
- `apps/farm-service/src/__tests__/e2e/code-generator-tenant-sequence.postgres.spec.ts`
