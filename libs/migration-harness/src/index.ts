/**
 * @platform/migration-harness — Ephemeral Postgres Test Harness for Migrations
 * ============================================================================
 *
 * devDependencies-only library. Ships testcontainers + @testcontainers/postgresql
 * for isolated per-suite PG boots. MUST NOT enter the production service graph;
 * enforced by `project.json` tag `scope:devOnly` + ESLint boundary rule.
 *
 * Purpose: reproduce the HR-drift 5-commit loop (`5df00179` → `e83904d2`) in
 * <60s on a developer laptop so any future entity/migration combo that would
 * cause the same class of drift is caught at PR time — not at a 7.5-minute
 * boot-signal timeout on the production droplet.
 *
 * See:
 *   - docs/patterns/jest-testcontainers.md — shared-container-per-file pattern
 *   - docs/patterns/nx-lib-creation.md — deviations applied to this lib
 *   - docs/plans/2026-04-21-db-migrate-enterprise-refactor.md §Phase 1
 *
 * API surface grows across Phase 1 commits. Current exports:
 *   - bootPostgresContainer / shutdownHarness / withEphemeralSchema (setup.ts)
 * Next commits:
 *   - defineMigrationTest — declarative per-migration test wrapper
 *   - expectNoDriftAgainst + toHaveNoDrift matcher — validator assertion
 *   - HR-drift regression spec (proof of concept)
 */
export {
  DEFAULT_POSTGRES_IMAGE,
  bootPostgresContainer,
  shutdownHarness,
  withEphemeralDatabase,
  withEphemeralSchema,
} from './setup';
export type {
  BootOptions,
  EphemeralDatabaseContext,
  HarnessContext,
  SchemaHarnessContext,
} from './setup';

export { defineMigrationTest } from './define-migration-test';
export type {
  AssertionsCallback,
  DefineMigrationTestOpts,
  MigrationClass,
  PriorStateCallback,
} from './define-migration-test';

export { expectNoDriftAgainst, registerDriftMatcher } from './expect-no-drift';
export type { DriftClass, DriftReport } from './expect-no-drift';
