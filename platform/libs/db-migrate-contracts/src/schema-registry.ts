export interface SchemaRegistryEntry {
  /** Service that owns this schema (or "platform" for cross-service). */
  readonly service: string;
  /** PostgreSQL schema name. Must match @Entity schema: option (ADR-011). */
  readonly schema: string;
  /** PostgreSQL runtime role that owns the schema and receives service grants. */
  readonly role: string;
  /**
   * Glob pattern pointing at timestamped migration files.
   *
   * Globs are relative to the db-migrate container workdir at runtime and must
   * include `[0-9]*` after `/migrations/` so TypeORM only loads migrations.
   */
  readonly migrationsGlob: readonly string[];
  /**
   * Optional entity metadata globs for migrations that intentionally derive a
   * one-shot catch-up plan from TypeORM entity metadata.
   */
  readonly entitiesGlob?: readonly string[];
  /**
   * Optional schema hardening steps that must run inside aqua-db-migrate after
   * TypeORM migrations and before service containers boot.
   */
  readonly postMigrationHardening?: SchemaPostMigrationHardening;
  /** Human-readable rationale for the ordering slot. */
  readonly reason: string;
}

export interface SchemaPostMigrationHardening {
  /** Install canonical tenant RLS policies on tenant-scoped tables. */
  tenantRls?:
    | true
    | {
        excludeTables?: readonly string[];
        tenantIdColumns?: readonly string[];
      };
  /** Convert audit timestamp columns to TIMESTAMPTZ. */
  auditColumns?:
    | true
    | {
        excludeTables?: readonly string[];
        auditColumns?: readonly string[];
      };
  /** Operator-visible reason emitted in db-migrate logs. */
  reason: string;
}

const TENANT_SCHEMA_POST_MIGRATION_HARDENING: SchemaPostMigrationHardening = {
  tenantRls: true,
  auditColumns: true,
  reason:
    'Tenant-aware schemas are cloned into tenant_<uuid> schemas by aqua-db-migrate. ' +
    'RLS and audit hardening must run in the db-migrate provisioner, not from runtime services.',
};

const SCHEMA_REGISTRY_ENTRIES = [
  {
    service: 'auth-service',
    schema: 'auth',
    role: 'auth_service',
    migrationsGlob: ['apps/auth-service/src/migrations/[0-9]*{.ts,.js}'],
    postMigrationHardening: {
      tenantRls: {
        excludeTables: ['auth_outbox', 'audit_log', 'audit_logs', 'users', 'tenants'],
      },
      reason:
        'Auth runtime RLS auto-apply is gated off when aqua-db-migrate is authoritative; ' +
        'canonical tenant isolation policies must be installed by the provisioner.',
    },
    reason:
      'Tenant trust root. auth.tenants is referenced by downstream service tenantId keys.',
  },
  {
    service: 'farm-service',
    schema: 'farm',
    role: 'farm_service',
    migrationsGlob: ['apps/farm-service/src/database/migrations/[0-9]*{.ts,.js}'],
    postMigrationHardening: TENANT_SCHEMA_POST_MIGRATION_HARDENING,
    reason: 'Primary aquaculture domain with the highest downstream fan-out.',
  },
  {
    service: 'sensor-service',
    schema: 'sensor',
    role: 'sensor_service',
    migrationsGlob: ['apps/sensor-service/src/database/migrations/[0-9]*{.ts,.js}'],
    postMigrationHardening: TENANT_SCHEMA_POST_MIGRATION_HARDENING,
    reason: 'Telemetry source schema; must settle before alert consumers validate metrics.',
  },
  {
    service: 'hr-service',
    schema: 'hr',
    role: 'hr_service',
    migrationsGlob: ['apps/hr-service/src/database/migrations/[0-9]*{.ts,.js}'],
    entitiesGlob: ['apps/hr-service/src/**/*.entity.{ts,js}'],
    postMigrationHardening: TENANT_SCHEMA_POST_MIGRATION_HARDENING,
    reason: 'Schema-per-tenant service cloned into tenant schemas during onboarding.',
  },
  {
    service: 'messaging-service',
    schema: 'messaging',
    role: 'messaging_service',
    migrationsGlob: [
      'apps/messaging-service/src/migrations/[0-9]*{.ts,.js}',
      'apps/messaging-service/src/database/migrations/[0-9]*{.ts,.js}',
    ],
    postMigrationHardening: TENANT_SCHEMA_POST_MIGRATION_HARDENING,
    reason: 'Schema-per-tenant messaging domain with auth.tenants-backed RLS policies.',
  },
  {
    service: 'hydroponics-service',
    schema: 'hydroponics',
    role: 'hydroponics_service',
    migrationsGlob: ['apps/hydroponics-service/src/database/migrations/[0-9]*{.ts,.js}'],
    postMigrationHardening: TENANT_SCHEMA_POST_MIGRATION_HARDENING,
    reason: 'Farm-adjacent tenant schema; placeholder keeps first migration zero-drift.',
  },
  {
    service: 'alert-engine',
    schema: 'alert',
    role: 'alert_service',
    migrationsGlob: ['apps/alert-engine/src/database/migrations/[0-9]*{.ts,.js}'],
    postMigrationHardening: TENANT_SCHEMA_POST_MIGRATION_HARDENING,
    reason: 'Consumes sensor and farm events after upstream schemas settle.',
  },
  {
    service: 'billing-service',
    schema: 'billing',
    role: 'billing_service',
    migrationsGlob: ['apps/billing-service/src/database/migrations/[0-9]*{.ts,.js}'],
    postMigrationHardening: {
      tenantRls: true,
      auditColumns: true,
      reason:
        'Billing is an authoritative financial schema; production DDL hardening belongs to aqua-db-migrate.',
    },
    reason: 'Consumes subscription and usage events after domain schemas.',
  },
  {
    service: 'notification-service',
    schema: 'notification',
    role: 'notification_service',
    migrationsGlob: ['apps/notification-service/src/database/migrations/[0-9]*{.ts,.js}'],
    postMigrationHardening: {
      tenantRls: true,
      auditColumns: true,
      reason:
        'Notification is a global tenant-scoped schema; RLS and audit hardening belong to aqua-db-migrate.',
    },
    reason: 'Cross-domain notification event sink.',
  },
  {
    service: 'ai-service',
    schema: 'ai',
    role: 'ai_service',
    migrationsGlob: ['apps/ai-service/src/database/migrations/[0-9]*{.ts,.js}'],
    postMigrationHardening: TENANT_SCHEMA_POST_MIGRATION_HARDENING,
    reason: 'Tenant-scoped AI context after upstream domain schemas.',
  },
  {
    service: 'admin-api-service',
    schema: 'admin',
    role: 'admin_service',
    migrationsGlob: ['apps/admin-api-service/src/migrations/[0-9]*{.ts,.js}'],
    reason: 'SUPER_ADMIN analytics and audit schema.',
  },
  {
    service: 'config-service',
    schema: 'config',
    role: 'config_service',
    migrationsGlob: ['apps/config-service/src/database/migrations/[0-9]*{.ts,.js}'],
    postMigrationHardening: {
      tenantRls: true,
      auditColumns: true,
      reason:
        'Config stores tenant-scoped configuration in a global schema; hardening belongs to aqua-db-migrate.',
    },
    reason: 'Dedicated dynamic configuration schema and service role.',
  },
  {
    service: 'observability-service',
    schema: 'observability',
    role: 'observability_service',
    migrationsGlob: ['apps/observability-service/src/database/migrations/[0-9]*{.ts,.js}'],
    reason: 'Metrics aggregation storage placeholder for first migration.',
  },
  {
    service: 'event-store-service',
    schema: 'event_store',
    role: 'event_store_service',
    migrationsGlob: ['apps/event-store-service/src/migrations/[0-9]*{.ts,.js}'],
    reason: 'Cross-service event persistence schema.',
  },
  {
    service: 'gateway-api',
    schema: 'gateway',
    role: 'gateway_service',
    migrationsGlob: ['apps/gateway-api/src/database/migrations/[0-9]*{.ts,.js}'],
    reason:
      'Reserved gateway schema for gateway operational state and least-privilege DATABASE_URL isolation.',
  },
] as const satisfies readonly SchemaRegistryEntry[];

type SchemaRegistryLiteralEntry = (typeof SCHEMA_REGISTRY_ENTRIES)[number];

export type SchemaRegistryRole = SchemaRegistryLiteralEntry['role'];
export type RegisteredSchemaName = SchemaRegistryLiteralEntry['schema'];
export type RegisteredServiceName = SchemaRegistryLiteralEntry['service'];

export type RegisteredSchemaRegistryEntry = SchemaRegistryEntry & SchemaRegistryLiteralEntry;

export const SCHEMA_REGISTRY: readonly RegisteredSchemaRegistryEntry[] =
  SCHEMA_REGISTRY_ENTRIES;
