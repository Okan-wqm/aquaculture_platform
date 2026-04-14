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

// Tenant Schema Sync (auto-provisioning)
export * from './tenant-schema-sync.service';

// Source Schema Write Guard (DB-level tenant isolation trigger)
export * from './source-schema-write-guard';

// Watchdog system (source contamination scanner, cross-tenant probe, drift detector)
export * from './watchdog';

// Tenant Connection Bootstrap (centralized factory)
export { createTenantConnectionBootstrap } from './tenant-connection-bootstrap.service';

// Row-Level Security (RLS) for PostgreSQL tenant isolation
export * from './rls';

// Migration runner factory — produces an OnApplicationBootstrap provider
// that runs pending TypeORM migrations with a runner-enforced search_path
// invariant. Shared across every service that wires TypeORM migrations
// (farm, hr, messaging, sensor, billing, config, notification, alert, ai,
// event-store); each calls the factory with its own source schema name.
export * from './migration-runner';

// Audit-column TIMESTAMP → TIMESTAMPTZ conversion (NEW-H1).
// `convertAuditColumnsToTimestamptz` and `revertAuditColumnsToTimestamp`
// are imported by per-service migrations in `auth`, `admin-api`, `farm`,
// `sensor`, and `messaging`. `AuditColumnsBootstrap` is the runtime
// installer used by services without a migration runner via the
// `AuditColumnsModule` dynamic module below.
export * from './convert-audit-columns-to-timestamptz.helper';
export * from './audit-columns-bootstrap.service';
export * from './audit-columns.module';
