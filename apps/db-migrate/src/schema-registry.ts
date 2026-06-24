/**
 * Schema ordering manifest for the aqua-db-migrate container.
 * ============================================================================
 *
 * ADR-033 — authoritative production schema order.
 *
 * Declares the deterministic order in which schema migrations are applied
 * by the one-shot migration container that runs BEFORE service containers
 * start. Today, every service's OnApplicationBootstrap runs its own
 * migration runner in parallel; with 14 services restarting simultaneously,
 * race conditions on shared resources (RLS policy install on the `shared`
 * schema, DDL on source tables that feed tenant-schema clones, index
 * builds against the same TimescaleDB hypertables) become real.
 *
 * This registry is the source of truth for "what schemas exist, who owns
 * them, and in what order they migrate." The order is not cosmetic — it
 * mirrors the read-dependency topology:
 *
 *   1. `shared` / `public` — cross-cutting tables (audit_logs,
 *      gdpr_data_requests, user_consents, user_permissions, platform_migrations).
 *      Not a service-owned schema. Initialized by postgres init-scripts
 *      (00-init-schemas.sh) BEFORE any container including this one starts.
 *      Listed here for documentation only; the runner does NOT own
 *      shared-schema migrations.
 *
 *   2. `auth` — the trust root. Tenant table lives here. Every other
 *      service's foreign keys (via tenantId) eventually point back to an
 *      auth.tenants row. Auth must be fully migrated before any other
 *      service's RLS policies install (they reference auth.tenants).
 *
 *   3. `farm` / `sensor` / `hr` / `messaging` / `hydroponics` — primary
 *      domain schemas. Each is self-contained but all depend on `auth`.
 *      Ordered by dependency weight: farm has the most downstream
 *      consumers, sensor feeds farm telemetry, hr owns scheduling that
 *      feeds farm ops, messaging is cross-domain, hydroponics is a
 *      farm-adjacent domain.
 *
 *   4. `alert` / `billing` / `notification` / `ai` — consumer schemas
 *      that subscribe to events from the domain schemas above. Their
 *      migrations often reference column names that upstream migrations
 *      introduced (e.g. alert rules reading sensor_service's aggregate
 *      column shape). Running these after the domain schemas guarantees
 *      forward-compatibility.
 *
 *   5. `admin` / `config` / `observability` / `event_store` — platform
 *      utility schemas. No cross-schema dependencies; ordered last so
 *      their migrations never see a half-migrated domain schema.
 *
 * # Production scope
 *
 * This container is the single production schema writer. Application
 * services use schema-version gates in production: they may refuse boot
 * if this container did not complete, but they do not advance migration
 * ledgers. The registry therefore has release semantics, not just local
 * migration-runner ordering semantics.
 *
 * # Why a static registry instead of auto-discovery
 *
 * A filesystem glob walk (e.g. `apps/*\/src/**\/migrations/*.ts`) would
 * look simpler, but it makes ORDERING implicit on directory enumeration
 * order — different filesystems (ext4, xfs, overlayfs) return entries
 * in different orders, and a deploy that worked on a dev box could race
 * on a droplet. This file pins the ordering by hand so the architecturally
 * correct topology is reviewable in the diff.
 *
 * # Why `migrationsGlob` (not class imports)
 *
 * The migration container is deliberately decoupled from each service's
 * NestJS bootstrap. Importing migration classes directly would require
 * this container to compile every service's source tree plus their
 * transitive backend-common dependencies. Instead, we let TypeORM load
 * migrations from disk at runtime — the same mechanism the services'
 * own CLI data-source.ts files use. The glob is deliberately restricted
 * to timestamp-prefixed files (`[0-9]*`) so support modules such as
 * `manifest.ts`, helpers, and constants can live near migrations without
 * TypeORM importing them as migrations. This keeps "add a new
 * timestamped migration" a zero-change event for this file while preventing
 * the duplicate-class failure where a manifest imports every migration and
 * the glob imports both the manifest and the original files.
 *
 * The Dockerfile copies each service's migrations directory into the
 * container at its canonical path so the globs below match at runtime.
 */

export interface SchemaRegistryEntry {
  /** Service that owns this schema (or "platform" for cross-service). */
  service: string;
  /** PostgreSQL schema name. Must match @Entity schema: option (ADR-011). */
  schema: string;
  /**
   * Optional owning PostgreSQL role for this schema. When set, the init-schemas
   * generator (scripts/schema-registry/generate-init-schemas.ts) emits
   * `CREATE SCHEMA … AUTHORIZATION <role>` + `ALTER SCHEMA … OWNER TO <role>`,
   * grants the role access to the shared cross-service tables (ADR-011 schema
   * ownership), and the SCHEMA_REGISTRY ↔ init-schemas.sh invariant spec
   * validates the lockstep. Entries without a dedicated owning role omit it.
   */
  role?: string;
  /**
   * Glob pattern (RELATIVE TO THIS CONTAINER'S WORKDIR at runtime) pointing
   * at the migration files. Supports both .ts (dev run) and .js (container
   * run) via the `{.ts,.js}` suffix — TypeORM evaluates the appropriate one
   * based on what's actually on disk. Globs MUST include `[0-9]*` after
   * `/migrations/` so only timestamped migration files are auto-loaded.
   *
   * NOTE: the container's Dockerfile MUST copy each service's migrations
   * into a predictable path. See `infrastructure/docker/Dockerfile.db-migrate`.
   */
  migrationsGlob: string[];
  /**
   * Optional entity metadata globs for migrations that intentionally use
   * `connection.entityMetadatas` / `RdbmsSchemaBuilder.log()` to compute a
   * one-shot catch-up plan. Most services do not need this; HR does because
   * its historical drift-heal migrations are entity-driven.
   */
  entitiesGlob?: string[];
  /**
   * Optional schema hardening steps that must run inside aqua-db-migrate,
   * after the schema's TypeORM migrations and before service containers boot.
   *
   * Use this for production DDL that application services are not allowed to
   * perform at runtime under DB_MIGRATE_AUTHORITATIVE=true.
   */
  postMigrationHardening?: SchemaPostMigrationHardening;
  /**
   * Human-readable rationale for the ordering slot. Logged on first pass
   * so operators reading deploy output see the reasoning without having
   * to open this source file.
   */
  reason: string;
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

/**
 * The ordered list. Edit here and ONLY here when adding a new service
 * with a new schema. Adding a schema out-of-order is reviewable in the
 * PR diff (the order is load-bearing — see docblock above).
 */
export const SCHEMA_REGISTRY: readonly SchemaRegistryEntry[] = [
  // ── Trust root ─────────────────────────────────────────────────────
  {
    service: 'auth-service',
    schema: 'auth',
    migrationsGlob: ['apps/auth-service/src/migrations/[0-9]*{.ts,.js}'],
    postMigrationHardening: {
      tenantRls: {
        // Mirrors the RlsModule.forPoolService excludeTables declared in
        // apps/auth-service/src/app.module.ts. `users`/`tenants` are
        // identity primitives (pre-auth lookups; SUPER_ADMIN rows carry
        // tenantId=NULL) — the helper also auto-skips them via
        // DEFAULT_IDENTITY_TABLES; listing them keeps the registry the
        // audit-visible declaration. Outbox + audit tables are
        // cross-tenant infrastructure by design.
        excludeTables: ['auth_outbox', 'audit_log', 'audit_logs', 'users', 'tenants'],
      },
      reason:
        'PR#363 port: auth runtime RLS auto-apply is gated off when ' +
        'aqua-db-migrate is authoritative (applyTenantRlsToSchema refuses ' +
        'runtime callers outright), so the canonical tenant_isolation_policy ' +
        'on auth tenant-scoped tables (invitations, refresh_tokens, ' +
        'announcements, …) must be installed here — the only legitimate ' +
        'DDL writer in production.',
    },
    reason:
      'Tenant trust root. auth.tenants is referenced (by tenantId FK) from ' +
      'every other service, so its migrations MUST settle before downstream ' +
      'RLS policies install.',
  },

  // ── Primary domain schemas ─────────────────────────────────────────
  {
    service: 'farm-service',
    schema: 'farm',
    migrationsGlob: ['apps/farm-service/src/database/migrations/[0-9]*{.ts,.js}'],
    postMigrationHardening: TENANT_SCHEMA_POST_MIGRATION_HARDENING,
    reason:
      'Primary aquaculture domain — highest fan-out of downstream ' +
      'consumers (alert-engine, billing, sensor aggregates).',
  },
  {
    service: 'sensor-service',
    schema: 'sensor',
    migrationsGlob: ['apps/sensor-service/src/database/migrations/[0-9]*{.ts,.js}'],
    postMigrationHardening: TENANT_SCHEMA_POST_MIGRATION_HARDENING,
    reason:
      'Feeds telemetry into farm-service batch/harvest pipelines. ' +
      'Installs TimescaleDB hypertables + continuous aggregates — ' +
      'must settle before alert-engine subscribes to its aggregate ' +
      'column shape.',
  },
  {
    service: 'hr-service',
    schema: 'hr',
    migrationsGlob: ['apps/hr-service/src/database/migrations/[0-9]*{.ts,.js}'],
    entitiesGlob: ['apps/hr-service/src/**/*.entity.{ts,js}'],
    postMigrationHardening: TENANT_SCHEMA_POST_MIGRATION_HARDENING,
    reason:
      'Schema-per-tenant service. Source-schema migrations clone into ' +
      'every tenant_<uuid> schema at tenant onboarding — running before ' +
      'alert/billing ensures tenant-clone payload is column-complete.',
  },
  {
    service: 'messaging-service',
    schema: 'messaging',
    migrationsGlob: [
      'apps/messaging-service/src/migrations/[0-9]*{.ts,.js}',
      'apps/messaging-service/src/database/migrations/[0-9]*{.ts,.js}',
    ],
    postMigrationHardening: TENANT_SCHEMA_POST_MIGRATION_HARDENING,
    reason:
      'Schema-per-tenant. RLS policies reference auth.tenants (ADR-011/014); ' +
      'must migrate after auth and before cross-service audit triggers.',
  },
  {
    service: 'hydroponics-service',
    schema: 'hydroponics',
    migrationsGlob: ['apps/hydroponics-service/src/database/migrations/[0-9]*{.ts,.js}'],
    postMigrationHardening: TENANT_SCHEMA_POST_MIGRATION_HARDENING,
    reason:
      'Schema-per-tenant, farm-adjacent domain. No migration files yet — ' +
      'entry kept as forward declaration so the first migration addition ' +
      'does not require a compose-graph change.',
  },

  // ── Event consumers ────────────────────────────────────────────────
  {
    service: 'alert-engine',
    schema: 'alert',
    migrationsGlob: ['apps/alert-engine/src/database/migrations/[0-9]*{.ts,.js}'],
    postMigrationHardening: TENANT_SCHEMA_POST_MIGRATION_HARDENING,
    reason:
      'Consumes sensor + farm events. Alert rule definitions reference ' +
      'metric column names — must migrate after sensor/farm to avoid ' +
      '"column does not exist" on rule validation.',
  },
  {
    service: 'billing-service',
    schema: 'billing',
    migrationsGlob: ['apps/billing-service/src/database/migrations/[0-9]*{.ts,.js}'],
    postMigrationHardening: {
      tenantRls: true,
      auditColumns: true,
      reason:
        'billing is an authoritative financial schema. Production DDL ' +
        'hardening must run in aqua-db-migrate, not from billing-service ' +
        'startup, so least-privilege service credentials never need table ' +
        'ownership to install RLS or rewrite audit columns.',
    },
    reason:
      'Consumes subscription/usage events. Independent of domain ' +
      'schemas at DDL level but reads domain-event payloads; ordering ' +
      'after domains keeps event-contract upcasters consistent.',
  },
  {
    service: 'notification-service',
    schema: 'notification',
    migrationsGlob: ['apps/notification-service/src/database/migrations/[0-9]*{.ts,.js}'],
    postMigrationHardening: {
      tenantRls: true,
      auditColumns: true,
      reason:
        'notification is a global tenant-scoped schema. Runtime services set tenant GUCs, ' +
        'but production RLS DDL and audit-column rewrites must run in aqua-db-migrate.',
    },
    reason:
      'Cross-domain event sink. Notification log references tenantId; ' +
      'runs after auth + domain schemas.',
  },
  {
    service: 'ai-service',
    schema: 'ai',
    migrationsGlob: ['apps/ai-service/src/database/migrations/[0-9]*{.ts,.js}'],
    postMigrationHardening: TENANT_SCHEMA_POST_MIGRATION_HARDENING,
    reason:
      'Schema-per-tenant AI context. Reads across domains for conversation ' +
      'context — last in the consumer tier to see all upstream columns.',
  },

  // ── Platform utility schemas ───────────────────────────────────────
  {
    service: 'admin-api-service',
    schema: 'admin',
    migrationsGlob: ['apps/admin-api-service/src/migrations/[0-9]*{.ts,.js}'],
    reason:
      'SUPER_ADMIN analytics + audit. Runs last in service tier so ' +
      'cross-schema read migrations see the final column shape.',
  },
  {
    service: 'config-service',
    schema: 'config',
    migrationsGlob: ['apps/config-service/src/database/migrations/[0-9]*{.ts,.js}'],
    postMigrationHardening: {
      tenantRls: true,
      auditColumns: true,
      reason:
        'config stores tenant-scoped configuration in a global schema. RLS policy install ' +
        'and audit-column hardening are production DDL and belong to aqua-db-migrate.',
    },
    reason:
      'Dynamic configuration keys. Wave 4-A.2 (2026-05-08) canonicalized ' +
      'the dedicated `config` schema + `config_service` role per ADR-011 ' +
      "update. Configuration entity declares schema: 'config'.",
  },
  {
    service: 'observability-service',
    schema: 'observability',
    migrationsGlob: [
      // no migrations yet; placeholder for the first migration addition
      'apps/observability-service/src/database/migrations/[0-9]*{.ts,.js}',
    ],
    reason:
      'Metrics aggregation storage. No migrations today (relies on ' +
      'bootstrapping via search_path); entry kept so the first migration ' +
      'does not require a compose-graph change.',
  },
  {
    service: 'event-store-service',
    schema: 'event_store',
    migrationsGlob: ['apps/event-store-service/src/migrations/[0-9]*{.ts,.js}'],
    reason:
      'Cross-service event persistence. Schema ordering is irrelevant ' +
      'at DDL level (no FKs into domain schemas); placed last so any ' +
      'new cross-cutting trigger sees the final domain column shape.',
  },
] as const;
