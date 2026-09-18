/**
 * Platform SCHEMA TOPOLOGY — the single source of truth for WHICH database
 * schemas exist and what role each one plays across the deploy/bootstrap/RLS
 * pipeline.
 *
 * WHY this file exists: the platform's schema set was previously hand-copied
 * into five divergent lists (`PLATFORM_SCHEMAS` in the bootstrap writer,
 * `SCHEMA_REGISTRY` in the migration runner, the `CREATE SCHEMA` block in
 * `003-schemas.sql`, `MODULE_SCHEMAS` in backend-common, and the boot gate's
 * `EXPECTED_SCHEMA_COUNT` literal). On 2026-07-13 a sibling count literal
 * (`shared_table_count = 5`) drifted from its source when ADR-042 retired a
 * shared table and crash-looped every backend service (ORPHAN-HIGH-387). Its
 * un-fixed siblings (`schema_count = 16`, `function_count = 4`) were the same
 * class (ORPHAN-HIGH-405). This registry makes every consumer DERIVE its
 * subset instead of hand-copying it.
 *
 * WHY the sets genuinely differ (this is reconciliation, not a typo): the five
 * lists are NOT congruent — they encode ORTHOGONAL facts, so this registry
 * carries one typed flag per fact rather than one list. The symmetric
 * differences, now explicit:
 *   - `gateway` / `shared` are created + counted at bootstrap but own no
 *     migration runner and no module manifest (they hold platform-owned tables
 *     written by SQL, not a per-service migration lane).
 *   - `compliance` is created at bootstrap (003) and has a module manifest, but
 *     is NOT counted in `bootstrap_signal.schema_count` (it is created without
 *     an owner role) and owns no migration runner.
 *   - `platform` is a pseudo-schema: it has a module manifest but no physical
 *     schema is created and it is not counted anywhere.
 *
 * IMPORT-FREE INVARIANT: this module (like the rest of `@platform/service-catalog`)
 * imports nothing. It is a pure data + type leaf so db-migrate, backend-common,
 * and the frontend can all consume it without pulling a heavy dependency and
 * without creating an import cycle. Do NOT add imports here.
 */

export interface PlatformSchemaEntry {
  /** Physical (or pseudo, for `platform`) schema name. */
  readonly schema: string;
  /**
   * Created by db-migrate stage 003 (`003-schemas.sql` CREATE SCHEMA). True for
   * every real schema; false only for the `platform` pseudo-schema.
   */
  readonly createdInBootstrap: boolean;
  /**
   * Counted in the `platform.bootstrap_signal.schema_count` post-condition —
   * i.e. a member of the bootstrap writer's `PLATFORM_SCHEMAS` list. A schema
   * created WITHOUT an owner role (`compliance`) is not counted here.
   */
  readonly countedInBootstrapSignal: boolean;
  /**
   * Owns a migration-runner entry in `SCHEMA_REGISTRY` (a per-service migration
   * lane + DB role). Platform-owned schemas whose tables are created by SQL
   * (`gateway`, `shared`) and the pseudo/uncounted ones (`compliance`,
   * `platform`) have none.
   */
  readonly hasMigrationRunner: boolean;
  /**
   * Has a `MODULE_SCHEMAS` manifest (entity/table registry) in backend-common.
   * `gateway`/`shared` do not; `compliance`/`platform` carry an empty
   * pseudo-module manifest.
   */
  readonly hasModuleManifest: boolean;
  /**
   * Per-tenant: entities OMIT the `@Entity schema:` option and the schema fans
   * out into `tenant_<uuid>` clones at runtime (ADR-011). Cross-tenant schemas
   * are false.
   */
  readonly tenantAware: boolean;
  /**
   * Task 4: this schema's tenant provisioner post-step creates the
   * TimescaleDB continuous aggregates for each provisioned tenant (the DDL
   * cannot run inside the migration runner's per-migration transactions).
   * Only `sensor` sets this today.
   */
  readonly provisionsTenantContinuousAggregates?: boolean;
}

/**
 * The canonical schema universe (18 schemas). Order is stable and
 * bootstrap-relevant (auth first, tenant-scoped domains, then platform infra).
 * Every consumer's list is a `filter()` of this table — never a hand-copy.
 */
export const PLATFORM_SCHEMA_TOPOLOGY: readonly PlatformSchemaEntry[] = [
  {
    schema: 'auth',
    createdInBootstrap: true,
    countedInBootstrapSignal: true,
    hasMigrationRunner: true,
    hasModuleManifest: true,
    tenantAware: false,
  },
  {
    schema: 'farm',
    createdInBootstrap: true,
    countedInBootstrapSignal: true,
    hasMigrationRunner: true,
    hasModuleManifest: true,
    tenantAware: true,
  },
  {
    schema: 'sensor',
    createdInBootstrap: true,
    countedInBootstrapSignal: true,
    hasMigrationRunner: true,
    hasModuleManifest: true,
    tenantAware: true,
    // Task 4 (100-tenant readiness plan): the tenant provisioner runs the
    // TimescaleDB continuous-aggregate DDL for THIS schema's tenants after
    // the migration fan-out (cagg DDL cannot run inside the runner's
    // per-migration transactions). New tenants get their rollups before
    // ACTIVE; existing tenants backfill through the rate-limited
    // RECONCILE queue.
    provisionsTenantContinuousAggregates: true,
  },
  {
    schema: 'hr',
    createdInBootstrap: true,
    countedInBootstrapSignal: true,
    hasMigrationRunner: true,
    hasModuleManifest: true,
    tenantAware: true,
  },
  {
    schema: 'messaging',
    createdInBootstrap: true,
    countedInBootstrapSignal: true,
    hasMigrationRunner: true,
    hasModuleManifest: true,
    tenantAware: true,
  },
  {
    schema: 'hydroponics',
    createdInBootstrap: true,
    countedInBootstrapSignal: true,
    hasMigrationRunner: true,
    hasModuleManifest: true,
    tenantAware: true,
  },
  {
    schema: 'alert',
    createdInBootstrap: true,
    countedInBootstrapSignal: true,
    hasMigrationRunner: true,
    hasModuleManifest: true,
    tenantAware: true,
  },
  {
    schema: 'ai',
    createdInBootstrap: true,
    countedInBootstrapSignal: true,
    hasMigrationRunner: true,
    hasModuleManifest: true,
    tenantAware: true,
  },
  {
    schema: 'billing',
    createdInBootstrap: true,
    countedInBootstrapSignal: true,
    hasMigrationRunner: true,
    hasModuleManifest: true,
    tenantAware: false,
  },
  {
    schema: 'notification',
    createdInBootstrap: true,
    countedInBootstrapSignal: true,
    hasMigrationRunner: true,
    hasModuleManifest: true,
    tenantAware: false,
  },
  {
    schema: 'admin',
    createdInBootstrap: true,
    countedInBootstrapSignal: true,
    hasMigrationRunner: true,
    hasModuleManifest: true,
    tenantAware: false,
  },
  {
    schema: 'config',
    createdInBootstrap: true,
    countedInBootstrapSignal: true,
    hasMigrationRunner: true,
    hasModuleManifest: true,
    tenantAware: false,
  },
  {
    schema: 'observability',
    createdInBootstrap: true,
    countedInBootstrapSignal: true,
    hasMigrationRunner: true,
    hasModuleManifest: true,
    tenantAware: false,
  },
  {
    schema: 'event_store',
    createdInBootstrap: true,
    countedInBootstrapSignal: true,
    hasMigrationRunner: true,
    hasModuleManifest: true,
    tenantAware: false,
  },
  {
    schema: 'gateway',
    createdInBootstrap: true,
    countedInBootstrapSignal: true,
    hasMigrationRunner: false,
    hasModuleManifest: false,
    tenantAware: false,
  },
  {
    schema: 'shared',
    createdInBootstrap: true,
    countedInBootstrapSignal: true,
    hasMigrationRunner: false,
    hasModuleManifest: false,
    tenantAware: false,
  },
  {
    schema: 'compliance',
    createdInBootstrap: true,
    countedInBootstrapSignal: false,
    hasMigrationRunner: false,
    hasModuleManifest: true,
    tenantAware: false,
  },
  {
    schema: 'platform',
    createdInBootstrap: false,
    countedInBootstrapSignal: false,
    hasMigrationRunner: false,
    hasModuleManifest: true,
    tenantAware: false,
  },
] as const;

/**
 * Platform functions installed in db-migrate stage 005 and counted in
 * `bootstrap_signal.function_count`. Kept beside the schema topology because
 * the boot gate derives `EXPECTED_FUNCTION_COUNT` from this list's length.
 */
export const PLATFORM_FUNCTIONS: readonly string[] = [
  'current_tenant_id',
  'set_tenant_id',
  'update_updated_at_column',
  'audit_immutability_guard',
] as const;

/** Schemas created by stage 003 bootstrap (`003-schemas.sql`). 17 today. */
export function bootstrapCreatedSchemas(): readonly string[] {
  return PLATFORM_SCHEMA_TOPOLOGY.filter((s) => s.createdInBootstrap).map((s) => s.schema);
}

/**
 * Schemas counted in `platform.bootstrap_signal.schema_count` (the bootstrap
 * writer's `PLATFORM_SCHEMAS`). The boot gate's `EXPECTED_SCHEMA_COUNT` is this
 * list's length. 16 today.
 */
export function bootstrapSignalSchemas(): readonly string[] {
  return PLATFORM_SCHEMA_TOPOLOGY.filter((s) => s.countedInBootstrapSignal).map((s) => s.schema);
}

/** Schemas owning a migration-runner lane (`SCHEMA_REGISTRY`). 14 today. */
export function migrationRunnerSchemas(): readonly string[] {
  return PLATFORM_SCHEMA_TOPOLOGY.filter((s) => s.hasMigrationRunner).map((s) => s.schema);
}

/** Schemas carrying a `MODULE_SCHEMAS` manifest in backend-common. 16 today. */
export function moduleManifestSchemas(): readonly string[] {
  return PLATFORM_SCHEMA_TOPOLOGY.filter((s) => s.hasModuleManifest).map((s) => s.schema);
}

/** Per-tenant (fan-out) schemas. 7 today. */
export function tenantAwareSchemas(): readonly string[] {
  return PLATFORM_SCHEMA_TOPOLOGY.filter((s) => s.tenantAware).map((s) => s.schema);
}

/** Platform function names (stage 005). */
export function platformFunctions(): readonly string[] {
  return [...PLATFORM_FUNCTIONS];
}
