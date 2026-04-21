// Schema Manager
export * from './schema-manager.service';

// Source Schema Bootstrap
export * from './source-schema-bootstrap.service';

// Tenant-Aware Repository (legacy request-scoped, HTTP-only)
export * from './tenant-aware.repository';

// Tenant-Scoped Repository (AsyncLocalStorage-based, works in HTTP + MQTT + cron + NATS)
export * from './tenant-scoped-repository';
export * from './tenant-scoped-repository.module';

// Transformers
export * from './decimal-transformer';

// Schema LRU Cache (for tenant-schema middleware)
export * from './schema-lru-cache';

// Tenant Schema Utilities (pure functions, no DI required)
export * from './tenant-schema.utils';

// Migration Logger (structured logging for TypeORM migrations outside DI)
export { MigrationLogger } from './migration-logger';

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
} from './base-migration';
export type {
  AlterColumnTypeTarget,
  BlockingDependency,
  BlockingDependencyKind,
  /** @deprecated alias for {@link BlockingDependency} */
  BlockingPartialIndex,
} from './base-migration';

// TENANT_AWARE_SCHEMAS — SSoT for schema-per-tenant services. Imported
// by migration-runner.service.ts (boot-time fan-out), aqua-db-migrate
// orchestrator (deploy-time fan-out), and schema-propagation.spec.ts
// (CI invariant). See tenant-aware-schemas.ts for rationale.
export {
  TENANT_AWARE_SCHEMAS,
  TENANT_SCHEMA_NAME_RE,
} from './tenant-aware-schemas';

// Tenant Schema Sync (auto-provisioning)
export * from './tenant-schema-sync.service';

// Source Schema Write Guard (DB-level tenant isolation trigger)
export * from './source-schema-write-guard';

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
export {
  DRIFT_CLASSES,
  DRIFT_CLASS_LIST,
  isDriftClassId,
} from './schema-drift/drift-classes';
export type {
  DriftClassId,
  DriftClassSpec,
  DriftSeverity,
} from './schema-drift/drift-classes';

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
  SchemaSnapshot,
} from './schema-drift/pg-catalog-introspector';

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
// `sensor`, and `messaging`. `AuditColumnsBootstrap` is the runtime
// installer used by services without a migration runner via the
// `AuditColumnsModule` dynamic module below.
export * from './convert-audit-columns-to-timestamptz.helper';
export * from './audit-columns-bootstrap.service';
export * from './audit-columns.module';
