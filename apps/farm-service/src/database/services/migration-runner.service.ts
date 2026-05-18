import { createSchemaVersionGate } from '@aquaculture/backend-common/database';

/**
 * MigrationRunnerService for farm-service (Faz 1.5 of day-one baseline reset).
 *
 * Now delegates to `createSchemaVersionGate('farm')` — a strict superset of
 * `createMigrationRunnerService('farm')`:
 *
 *   • production (`DB_MIGRATE_AUTHORITATIVE=true`) — read-only ledger
 *     probe; refuses boot if `aqua-db-migrate` has not finalised the
 *     `farm` ledger. Collapses the two-writer surface that produced the
 *     2026-04 HR drift.
 *   • development (default)                       — delegates to the
 *     runner verbatim, preserving the dev/test ergonomics.
 *
 * Re-exported under the legacy `MigrationRunnerService` name so the rest
 * of farm-service's module wiring needs no edits. ADR-021 governs the
 * authoritative-runner cutover policy.
 *
 * @see createSchemaVersionGate at
 *      libs/backend-common/src/database/schema-version-gate.service.ts
 */
export const MigrationRunnerService = createSchemaVersionGate('farm');
