// Schema Manager
export * from './schema-manager.service';

// SQL identifier validator — single canonical helper for identifier
// interpolation (DDL paths use it instead of inlining a private regex).
export { validateSqlIdentifier } from './sql-identifier.util';
// Audit append-only contract SQL — one definition for all four audit tables.
export * from './audit-immutability.sql';
export type { SqlIdentifierKind } from './sql-identifier.util';

// TypeORM driver query result normalizer — single canonical adapter for
// raw `DataSource.query()` return shapes across Postgres and CLI/test drivers.
export {
  executeQueryResultNormalized,
  executeQueryRowsNormalized,
  queryResultNormalized,
  queryRowCountNormalized,
  queryRowsNormalized,
  queryRowsWithStringColumn,
  querySingleStringColumn,
} from './query-result-normalizer';
export type {
  NormalizedQueryResult,
  QueryResultExecutor,
  StringColumnRow,
} from './query-result-normalizer';

// Source Schema Bootstrap
export * from './source-schema-bootstrap.service';

// Tenant-Aware Repository (legacy request-scoped, HTTP-only)
export * from './tenant-aware.repository';

// Tenant-Scoped Repository (AsyncLocalStorage-based, works in HTTP + MQTT + cron + NATS)
export * from './tenant-scoped-repository';
export * from './tenant-scoped-repository.module';
export * from './tenant-transaction';
export * from './tenant-context-error';

// Transformers
export * from './decimal-transformer';

// Schema LRU Cache (for tenant-schema middleware)
export * from './schema-lru-cache';

// Shared tenant schema-existence cache (injectable singleton) + its
// provisioning-driven invalidation subscriber + SSoT module. Imported once
// per tenant-scoped service so TenantSchemaMiddleware and the TenantProvisioned
// subscriber share one cache instance (no stale-negative-cache block for
// freshly provisioned tenants).
export * from './tenant-schema-cache';

// Tenant Schema Utilities (pure functions, no DI required)
export * from './tenant-schema.utils';

// Fair, bounded per-tenant-schema cron/scheduler fan-out (cron-fairness).
// Bounded concurrency + per-tenant Node+DB timeout + error isolation + rotation.
export * from './for-each-tenant-schema';

// Migration Logger (structured logging for TypeORM migrations outside DI)
export { MigrationLogger } from './migration-logger';

// Migration ledger SSoT. Keep every runner/gate/tenant seeding path on the
// same TypeORM ledger table name.
export { MIGRATION_LEDGER_TABLE, tenantMigrationLedgerTable } from './migration-ledger';

// Tenant migration ledger privilege SSoT. aqua-db-migrate creates/backfills
// tenant ledgers; runtime services only need read access for SchemaVersionGate.
export {
  buildTenantMigrationLedgerReadGrant,
  grantTenantMigrationLedgerReadAccess,
  serviceRoleForTenantAwareSchema,
} from './tenant-migration-ledger-privileges';
export type {
  TenantMigrationLedgerQueryExecutor,
  TenantMigrationLedgerReadGrant,
  TenantMigrationLedgerReadGrantOptions,
} from './tenant-migration-ledger-privileges';
// Tenant-schema table privilege SSoT (2026-07-06 grant incident): per-tenant
// table clones must carry <source>_schema_owner ownership + <source>_service
// DML regardless of which connection created them. assert = idempotent align;
// verify = deploy/job-blocking drift detection.
export {
  assertTenantSchemaPrivileges,
  verifyTenantSchemaPrivileges,
  ownerRoleForTenantAwareSchema,
  tenantTablesForSourceSchema,
} from './tenant-schema-privileges';
export type {
  TenantSchemaPrivilegeExecutor,
  TenantSchemaPrivilegeOptions,
  TenantSchemaPrivilegeReport,
  TenantSchemaPrivilegeVerification,
  TenantSchemaPrivilegeViolation,
} from './tenant-schema-privileges';
export { grantTenantMessagingPartitionAuthority } from './messaging-partition-privileges';
export type {
  MessagingPartitionAuthorityGrant,
  MessagingPartitionAuthorityOptions,
  MessagingPartitionAuthorityQueryExecutor,
} from './messaging-partition-privileges';

// Migration helpers — column/table existence guards. Shared across all
// services for migrations that reference state created by squashed
// earlier migrations. See migration-helpers.ts docblock for rationale.
export { columnExists, tableExists } from './migration-helpers';

// Transactional outbox DDL — one SQL shape for every service-local
// outbox table that backs @platform/outbox. Migrations pass only schema,
// table, and object names; column/index contract stays centralized.

// SQL fragments — compile-time SQL injection prevention. Branded SqlIdent
// + SqlFragment types make raw-string interpolation a TypeScript compile
// error. Prereq for Phase 3 primitives rewrite (plan v3 R2 CRITICAL).
// See sql-fragments.ts docblock.
export { sql, sqlGuards, executeSqlFragment } from './sql-fragments';
export type { SqlIdent, SqlValue, SqlFragment } from './sql-fragments';

// Migration helpers (pinSearchPath, dropPartialTables,
// parseAlterColumnTypeTargets, dropDependentPartialIndexes) — shared by
// migration authors so search_path boilerplate, partial-state cleanup,
// and ALTER-COLUMN-TYPE dependency resolution live in one place.
// See base-migration.ts for rationale.
export {
  pinSearchPath,
  dropPartialTables,
  parseAlterColumnTypeTargets,
  dropDependentPartialIndexes,
  withDdlSafety,
} from './base-migration';
export type {
  AlterColumnTypeTarget,
  BlockingDependency,
  BlockingDependencyKind,
  /** @deprecated alias for {@link BlockingDependency} */
  BlockingPartialIndex,
  DdlSafetyOptions,
} from './base-migration';

// TENANT_AWARE_SCHEMAS — SSoT for schema-per-tenant services. Imported
// by migration-runner.service.ts (boot-time fan-out), aqua-db-migrate
// orchestrator (deploy-time fan-out), and schema-propagation.spec.ts
// (CI invariant). See tenant-aware-schemas.ts for rationale.
export { TENANT_AWARE_SCHEMAS, TENANT_SCHEMA_NAME_RE } from './tenant-aware-schemas';
export {
  SourceOnlyMigration,
  getSourceOnlyMigrationMetadata,
  isSourceOnlyMigration,
} from './tenant-fanout.decorator';
export type {
  SourceOnlyMigrationMetadata,
  SourceOnlyMigrationOptions,
} from './tenant-fanout.decorator';

// Tenant Schema Sync (auto-provisioning)
export * from './tenant-schema-sync.service';

// Source Schema Write Guard reconciler (DB-level tenant-isolation trigger SSoT)
export * from './source-schema-write-guard-reconciler';

// Watchdog system (source contamination scanner, cross-tenant probe, drift detector)
export * from './watchdog';

// Tenant Connection Bootstrap (centralized factory)
export { createTenantConnectionBootstrap } from './tenant-connection-bootstrap.service';

// TypeORM bootstrap factory — single source of truth for every service's
// TypeOrmModule.forRootAsync payload. Replaces 13 hand-rolled, drift-prone
// app.module.ts blocks. See INFRA-DB-POOL-001 + the factory's docblock.
export {
  createServiceTypeOrmConfig,
  DEFAULT_POOL_SIZE,
  DEFAULT_POOL_MIN,
  DEFAULT_POOL_IDLE_TIMEOUT_MS,
  DEFAULT_POOL_CONNECTION_TIMEOUT_MS,
} from './typeorm-config.factory';
export type { ServiceTypeOrmOptions } from './typeorm-config.factory';

// SSL config helper — extracted previously but never wired in. Now consumed
// by the TypeORM factory above. Re-exported so direct callers (e.g. raw
// DataSource construction in CLI tools) can use the same logic.
export { buildDatabaseSslConfig } from './ssl-config';
export type { SslConfigResult } from './ssl-config';

// Row-Level Security (RLS) for PostgreSQL tenant isolation
export * from './rls';

// Migration runner factory — produces an OnApplicationBootstrap provider
// that runs pending TypeORM migrations with a runner-enforced search_path
// invariant. Shared across every service that wires TypeORM migrations
// (farm, hr, messaging, sensor, billing, config, notification, alert, ai,
// event-store); each calls the factory with its own source schema name.
export * from './migration-runner';

// MigrationRunnerModule — Phase 6 platform wiring wrapper. Services
// import `MigrationRunnerModule.forRoot({schema: 'hr'})` instead of
// pasting the factory providers block. Auto-threads the MigrationEventSink
// + ConfigService through Nest DI.
export { MigrationRunnerModule } from './migration-runner/migration-runner.module';
export type { MigrationRunnerModuleOptions } from './migration-runner/migration-runner.module';

// SchemaVersionGate — Faz 1.5 of day-one baseline reset + ADR-021.
// Strict superset of createMigrationRunnerService: in production-like
// envs (DB_MIGRATE_AUTHORITATIVE=true) runs as a read-only probe that
// refuses boot if aqua-db-migrate has not finalised the ledger. In dev
// (default) delegates to the runner verbatim. Use this factory in every
// service's app.module.ts instead of createMigrationRunnerService —
// production safety + dev ergonomics in a single provider class.
export { createSchemaVersionGate } from './schema-version-gate.service';
export type { SchemaVersionGateOptions } from './schema-version-gate.service';

// Retention — single-enforcer-many-policies pattern (plan v3 R17).
// Tables with SOC2 / KVKK retention windows register a policy at
// module-init; RetentionEnforcementService iterates all on a daily
// cron. See retention/retention-policy.ts docblock.
export * from './retention';

// assertExpandContractDependency — R6 runtime gate. Called by
// MigrationRunnerService before executing each migration; contract-phase
// classes MUST have their dependsOn expand migration recorded in
// observability.migration_backfill_progress for the environment.
// See assert-expand-contract-dependency.ts docblock.
export { assertExpandContractDependency } from './assert-expand-contract-dependency';
export type {
  AssertDependencyOptions,
  AssertDependencyResult,
} from './assert-expand-contract-dependency';

// Schema drift validator — OnApplicationBootstrap provider factory that
// compares entity metadata against information_schema on every boot and
// fails fast on divergence (uuid→text drift, wrong schema, nullability
// mismatch). Would have caught the 2026-04-14 audit_logs.tenantId drift
// weeks before it broke RLS in production. Wire via SchemaDriftModule.forRoot()
// in each service's AppModule (consistent with RlsModule.forPoolService() pattern).
// The bare factory is exported for advanced wiring (e.g. tests with mocked
// DataSource) but services should prefer the module API.
export { createSchemaDriftValidator } from './schema-drift-validator.service';
export { SchemaDriftModule } from './schema-drift/schema-drift.module';
export type { SchemaDriftModuleOptions } from './schema-drift/schema-drift.module';

// Drift-class registry — single source of truth for validator ↔ primitive
// parity. See docs/plans/2026-04-21-db-migrate-enterprise-refactor.md §R11
// + libs/backend-common/src/database/schema-drift/drift-classes.ts docblock.
export { DRIFT_CLASSES, DRIFT_CLASS_LIST, isDriftClassId } from './schema-drift/drift-classes';
export type { DriftClassId, DriftClassSpec, DriftSeverity } from './schema-drift/drift-classes';
export {
  expectedEntityDbType,
  isUuidTypeDrift,
  normalizeInformationSchemaType,
} from './schema-drift/type-normalization';
export type {
  EntityColumnTypeShape,
  InformationSchemaColumnShape,
} from './schema-drift/type-normalization';

// pg_catalog introspector — normalized ORM-agnostic snapshot of a PG
// schema. Consumed by SchemaDriftValidator + Phase 4 PR gate. Replaces
// TypeORM's createSchemaBuilder().log() which is known to miss
// partial-index predicates, EXCLUDE operator classes, GIN opclass.
export { introspectSchema } from './schema-drift/pg-catalog-introspector';
export type {
  IntrospectedCheckConstraint,
  IntrospectedColumn,
  IntrospectedEnum,
  IntrospectedTable,
  IntrospectedPartialIndex,
  IntrospectedExcludeConstraint,
  IntrospectedForeignKeyAction,
  IntrospectedGeneratedColumn,
  IntrospectedHypertable,
  IntrospectedRlsPolicy,
  SchemaSnapshot,
} from './schema-drift/pg-catalog-introspector';

// Phase 4 PR-gate foundation — pairwise snapshot diff + severity
// partitioning. Pure, side-effect-free; consumed by the CI diff
// script that compares pre-merge vs post-migrate shadow snapshots.
export { diffSnapshots, partitionBySeverity } from './schema-drift/diff-snapshots';
export type {
  SnapshotChange,
  SnapshotChangeKind,
  SnapshotChangeSeverity,
} from './schema-drift/diff-snapshots';

// Phase 7 R14 — snapshot PII scrubber. Produces a redacted copy of a
// SchemaSnapshot suitable for cross-region upload or public channels.
export { scrubSnapshot, DEFAULT_PII_COLUMN_NAMES } from './schema-drift/snapshot-scrubber';
export type { ScrubbedSnapshot, ScrubOptions } from './schema-drift/snapshot-scrubber';

// Phase 3 primitives — declarative schema healers for drift classes
// A-G. Each primitive composes over withDdlSafety and sql.* branded
// fragments; raw-string SQL is a compile error at the call site.
// addMissingColumns heals Class D (entity declares column, DB lacks).
// alignColumnNullability heals Class C (entity NOT NULL, DB nullable).
export { addMissingColumns } from './schema-primitives/add-missing-columns';
export type {
  AddMissingColumnSpec,
  AddMissingColumnsOptions,
  AddMissingColumnsResult,
} from './schema-primitives/add-missing-columns';
export { alignColumnNullability } from './schema-primitives/align-column-nullability';
export type {
  AlignColumnNullabilitySpec,
  AlignColumnNullabilityOptions,
  AlignColumnNullabilityResult,
} from './schema-primitives/align-column-nullability';
export { alignEnumLabels } from './schema-primitives/align-enum-labels';
export type {
  AlignEnumLabelsTarget,
  AlignEnumLabelsOptions,
  AlignEnumLabelsResult,
} from './schema-primitives/align-enum-labels';
export { dropOrphanedColumns } from './schema-primitives/drop-orphaned-columns';
export type {
  DropOrphanedColumnsOptions,
  DropOrphanedColumnsResult,
} from './schema-primitives/drop-orphaned-columns';
export { alignCheckConstraints } from './schema-primitives/align-check-constraints';
export type {
  CheckConstraintSpec,
  AlignCheckConstraintsOptions,
  AlignCheckConstraintsResult,
} from './schema-primitives/align-check-constraints';
export { alignColumnType } from './schema-primitives/align-column-type';
export type {
  AlignColumnTypeSpec,
  AlignColumnTypeOptions,
  AlignColumnTypeResult,
} from './schema-primitives/align-column-type';
// Phase 3.5 — chunked Class H backfill primitive (large-table safe).
export { backfillColumn } from './schema-primitives/backfill-column';
export type {
  BackfillColumnOptions,
  BackfillColumnResult,
  BackfillProgress,
} from './schema-primitives/backfill-column';

// Emergency override runtime read — aqua-ctl + validator integration
// point. Lookups observability.emergency_overrides for ACTIVE rows
// matching (service, kind, environment). Fail-safe: lookup errors
// never grant bypass. See emergency-override-check.ts docblock.
export { lookupEmergencyOverride } from './emergency-override-check';
export type {
  EmergencyOverrideKind,
  EmergencyOverrideRow,
  EmergencyOverrideLookupResult,
  EmergencyOverrideLookupOptions,
} from './emergency-override-check';

// MigrationEventSink — decoupled hook for lifecycle-event emission from
// the per-service MigrationRunnerService. Phase 6 integration layer.
// See migration-event-sink.ts for the three provided implementations
// (NoopMigrationEventSink, InMemoryMigrationEventSink for tests,
// LoggerMigrationEventSink for dev/staging).
export {
  NoopMigrationEventSink,
  InMemoryMigrationEventSink,
  LoggerMigrationEventSink,
} from './migration-event-sink';
export type {
  MigrationEventSink,
  MigrationSinkEvent,
  MigrationSinkEventType,
} from './migration-event-sink';
// NATS bridge publisher — Phase 6 Step 5. Translates lifecycle events
// into SchemaMigrationEvent wire shape + publishes under
// SCHEMA_MIGRATION_SUBJECT_PREFIX. Observability-service consumer
// subscribes in Step 6.
export { NatsMigrationEventSink } from './nats-migration-event-sink';
export type {
  MigrationEventPublisher,
  NatsMigrationEventSinkOptions,
} from './nats-migration-event-sink';

// @TenantFanOut + @AllowTenantDelta — Phase 6 R21/R24 migration-class
// metadata. Orchestrator reads fan-out policy; Class I drift check
// reads tenant delta allowlist. See tenant-fanout.decorator.ts.
export {
  TenantFanOut,
  AllowTenantDelta,
  TENANT_FANOUT_META_KEY,
  ALLOW_TENANT_DELTA_META_KEY,
  getTenantFanOutMetadata,
  getAllowedTenantDeltaPrefixes,
  isTenantDeltaAllowed,
} from './tenant-fanout.decorator';
export type {
  TenantLockClass,
  TenantFanOutOptions,
  TenantFanOutMetadata,
  AllowTenantDeltaOptions,
  AllowTenantDeltaMetadata,
} from './tenant-fanout.decorator';

// @ExpandContract — declarative marker for blue-green migration phases.
// Phase 4 PR-gate reads this metadata to authorize breaking diffs on
// contract-phase migrations. See expand-contract.decorator.ts.
export {
  ExpandContract,
  EXPAND_CONTRACT_META_KEY,
  getExpandContractMetadata,
  authorizesBreaking,
  classifyMigrationsForBreaking,
} from './expand-contract.decorator';
export type {
  ExpandContractPhase,
  ExpandContractOptions,
  ExpandContractMetadata,
  MigrationClassification,
  BatchClassificationResult,
} from './expand-contract.decorator';

// @EncryptedAtRest — declarative marker for cryptographically-encrypted
// columns. Drift validator Class J enforces bytea storage; Phase 3
// primitives refuse DDL against decorated columns. See ADR-023.
export {
  EncryptedAtRest,
  ENCRYPTED_AT_REST_META_KEY,
  getEncryptedAtRestMetadata,
  getEncryptedAtRestForProperty,
} from './encrypted-at-rest.decorator';
export type {
  EncryptionAlgorithm,
  EncryptedAtRestOptions,
  EncryptedAtRestMetadata,
} from './encrypted-at-rest.decorator';

// Audit-column TIMESTAMP → TIMESTAMPTZ conversion (NEW-H1).
// `convertAuditColumnsToTimestamptz` and `revertAuditColumnsToTimestamp`
// are imported by per-service migrations in `auth`, `admin-api`, `farm`,
// `sensor`, and `messaging`. Under DB_MIGRATE_AUTHORITATIVE deployments,
// audit hardening belongs in aqua-db-migrate postMigrationHardening; the
// runtime `AuditColumnsModule` is a local/dev convenience only.
export * from './convert-audit-columns-to-timestamptz.helper';
export * from './audit-columns-bootstrap.service';
export * from './audit-columns.module';
export * from './db-migrate-authority.util';

// DATA-LOW-001 cure: typed pg.Pool extractor that hides the
// single `as any` driver-shape bridge in one canonical adapter.
// Connection-bootstrap services import this instead of casting
// dataSource.driver inline.
export * from './pg-pool-from-data-source.util';

// ORPHAN-HIGH-318 cure: runtime-asserted reader for raw
// `UPDATE … RETURNING` results through dataSource.query() — the postgres
// driver returns [rows, affectedCount], not the rows array; hand-typed
// annotations of that shape have already shipped one silent security-signal
// outage (ACCOUNT_LOCKED never fired).
export * from './update-returning.util';
