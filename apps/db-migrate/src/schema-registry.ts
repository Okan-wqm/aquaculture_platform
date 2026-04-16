/**
 * Schema ordering manifest for the aqua-db-migrate container.
 * ============================================================================
 *
 * WS10 / ADR-016 Phase E — Phase 1 (backward-compatible).
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
 * # Phase 1 scope (this file)
 *
 * Phase 1 is BACKWARD-COMPATIBLE: this container runs migrations once
 * before service containers start, but each service's existing
 * `createMigrationRunnerService` remains registered in its AppModule.
 * When a service boots after this container completes, its runner
 * observes "all migrations applied" and exits quickly. Phase 1 is a
 * safety net — if this container fails, a service's own runner is
 * still the authoritative fallback.
 *
 * Phase 2 (tracked as TRACKED-DEPLOY-003 — staging-first validation
 * required) removes the per-service runners and replaces them with a
 * schema-version gate that refuses boot when the container hasn't run.
 * That flip requires WS9 (staging environment) first so the rollback
 * drill can be exercised without touching production.
 *
 * # Why a static registry instead of auto-discovery
 *
 * A filesystem glob walk (e.g. `apps/<svc>/src/**\/migrations/*.ts`) would
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
 * own CLI data-source.ts files use. This keeps this container's bundle
 * small and makes "add a new migration" a zero-change event for this
 * file (the new .ts/.js simply shows up under the glob).
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
   * Database role that owns this schema. Must match a CREATE ROLE
   * statement in infrastructure/docker/init-scripts/00-init-schemas.sh.
   * `scripts/schema-registry/generate-init-schemas.ts` codegen reads
   * this field to emit the GENERATED CREATE SCHEMA + ALTER OWNER block.
   *
   * Omit for `public` (PostgreSQL auto-creates it; owned by the
   * superuser — no CREATE SCHEMA statement is emitted).
   */
  role?: string;
  /**
   * Glob pattern (RELATIVE TO THIS CONTAINER'S WORKDIR at runtime) pointing
   * at the migration files. Supports both .ts (dev run) and .js (container
   * run) via the `{.ts,.js}` suffix — TypeORM evaluates the appropriate one
   * based on what's actually on disk.
   *
   * NOTE: the container's Dockerfile MUST copy each service's migrations
   * into a predictable path. See `infrastructure/docker/Dockerfile.db-migrate`.
   */
  migrationsGlob: string[];
  /**
   * Human-readable rationale for the ordering slot. Logged on first pass
   * so operators reading deploy output see the reasoning without having
   * to open this source file.
   */
  reason: string;
}

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
    role: 'auth_service',
    migrationsGlob: [
      'apps/auth-service/src/migrations/*{.ts,.js}',
    ],
    reason:
      'Tenant trust root. auth.tenants is referenced (by tenantId FK) from ' +
      'every other service, so its migrations MUST settle before downstream ' +
      'RLS policies install.',
  },

  // ── Primary domain schemas ─────────────────────────────────────────
  {
    service: 'farm-service',
    schema: 'farm',
    role: 'farm_service',
    migrationsGlob: [
      'apps/farm-service/src/database/migrations/*{.ts,.js}',
    ],
    reason:
      'Primary aquaculture domain — highest fan-out of downstream ' +
      'consumers (alert-engine, billing, sensor aggregates).',
  },
  {
    service: 'sensor-service',
    schema: 'sensor',
    role: 'sensor_service',
    migrationsGlob: [
      'apps/sensor-service/src/database/migrations/*{.ts,.js}',
    ],
    reason:
      'Feeds telemetry into farm-service batch/harvest pipelines. ' +
      'Installs TimescaleDB hypertables + continuous aggregates — ' +
      'must settle before alert-engine subscribes to its aggregate ' +
      'column shape.',
  },
  {
    service: 'hr-service',
    schema: 'hr',
    role: 'hr_service',
    migrationsGlob: [
      'apps/hr-service/src/database/migrations/*{.ts,.js}',
    ],
    reason:
      'Schema-per-tenant service. Source-schema migrations clone into ' +
      'every tenant_<uuid> schema at tenant onboarding — running before ' +
      'alert/billing ensures tenant-clone payload is column-complete.',
  },
  {
    service: 'messaging-service',
    schema: 'messaging',
    role: 'messaging_service',
    migrationsGlob: [
      'apps/messaging-service/src/migrations/*{.ts,.js}',
      'apps/messaging-service/src/database/migrations/*{.ts,.js}',
    ],
    reason:
      'Schema-per-tenant. RLS policies reference auth.tenants (ADR-011/014); ' +
      'must migrate after auth and before cross-service audit triggers.',
  },
  {
    service: 'hydroponics-service',
    schema: 'hydroponics',
    role: 'hydroponics_service',
    migrationsGlob: [
      'apps/hydroponics-service/src/database/migrations/*{.ts,.js}',
    ],
    reason:
      'Schema-per-tenant, farm-adjacent domain. No migration files yet — ' +
      'entry kept as forward declaration so the first migration addition ' +
      'does not require a compose-graph change.',
  },

  // ── Event consumers ────────────────────────────────────────────────
  {
    service: 'alert-engine',
    schema: 'alert',
    role: 'alert_service',
    migrationsGlob: [
      'apps/alert-engine/src/database/migrations/*{.ts,.js}',
    ],
    reason:
      'Consumes sensor + farm events. Alert rule definitions reference ' +
      'metric column names — must migrate after sensor/farm to avoid ' +
      '"column does not exist" on rule validation.',
  },
  {
    service: 'billing-service',
    schema: 'billing',
    role: 'billing_service',
    migrationsGlob: [
      'apps/billing-service/src/database/migrations/*{.ts,.js}',
    ],
    reason:
      'Consumes subscription/usage events. Independent of domain ' +
      'schemas at DDL level but reads domain-event payloads; ordering ' +
      'after domains keeps event-contract upcasters consistent.',
  },
  {
    service: 'notification-service',
    schema: 'notification',
    role: 'notification_service',
    migrationsGlob: [
      'apps/notification-service/src/database/migrations/*{.ts,.js}',
    ],
    reason:
      'Cross-domain event sink. Notification log references tenantId; ' +
      'runs after auth + domain schemas.',
  },
  {
    service: 'ai-service',
    schema: 'ai',
    role: 'ai_service',
    migrationsGlob: [
      'apps/ai-service/src/database/migrations/*{.ts,.js}',
    ],
    reason:
      'Schema-per-tenant AI context. Reads across domains for conversation ' +
      'context — last in the consumer tier to see all upstream columns.',
  },

  // ── Platform utility schemas ───────────────────────────────────────
  {
    service: 'admin-api-service',
    schema: 'admin',
    role: 'admin_service',
    migrationsGlob: [
      'apps/admin-api-service/src/migrations/*{.ts,.js}',
    ],
    reason:
      'SUPER_ADMIN analytics + audit. Runs last in service tier so ' +
      'cross-schema read migrations see the final column shape.',
  },
  {
    service: 'config-service',
    schema: 'public',
    // No dedicated role — `public` is auto-created by PostgreSQL and
    // owned by the superuser. config-service connects as POSTGRES_USER.
    migrationsGlob: [
      'apps/config-service/src/database/migrations/*{.ts,.js}',
    ],
    reason:
      'Dynamic configuration keys. Lives in `public` as the only ' +
      'service that intentionally shares public tables (legacy — ' +
      'migration path tracked under ADR-011 consolidation).',
  },
  {
    service: 'observability-service',
    schema: 'observability',
    role: 'observability_service',
    migrationsGlob: [
      // no migrations yet; placeholder for the first migration addition
      'apps/observability-service/src/database/migrations/*{.ts,.js}',
    ],
    reason:
      'Metrics aggregation storage. No migrations today (relies on ' +
      'bootstrapping via search_path); entry kept so the first migration ' +
      'does not require a compose-graph change.',
  },
  {
    service: 'event-store-service',
    schema: 'event_store',
    role: 'event_store_service',
    migrationsGlob: [
      'apps/event-store-service/src/migrations/*{.ts,.js}',
    ],
    reason:
      'Cross-service event persistence. Schema ordering is irrelevant ' +
      'at DDL level (no FKs into domain schemas); placed last so any ' +
      'new cross-cutting trigger sees the final domain column shape.',
  },
] as const;
