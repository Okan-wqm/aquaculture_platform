/**
 * db-migrate authority resolver — SINGLE SOURCE OF TRUTH for deciding
 * whether `aqua-db-migrate` owns schema DDL for the current process.
 *
 * # WHY one module
 *
 * Before this consolidation (PR#363 design, reimplemented on main),
 * the same "is db-migrate authoritative?" question was answered by
 * four parallel snippets: an inline block in `typeorm-config.factory`,
 * a private `resolveMode()` in `schema-version-gate.service`, a local
 * resolver in `billing-service/app.module`, and this util. Parallel
 * resolvers drift — one accepts malformed `DB_MIGRATE_AUTHORITATIVE`
 * values silently, another doesn't — and a drifted answer on this
 * question is a schema-ownership incident. Every consumer now routes
 * through this module.
 *
 * # Resolution contract
 *
 *   1. `DB_MIGRATE_AUTHORITATIVE` explicit value wins. STRICT parse:
 *      only `'true'` / `'false'` (case-insensitive, trimmed) are
 *      accepted — any other non-empty value THROWS instead of being
 *      silently coerced to an environment default. A typo like
 *      `DB_MIGRATE_AUTHORITATIVE=yes` must fail the boot, not flip
 *      the schema-ownership model.
 *   2. Otherwise production-like environments default to authoritative:
 *      `NODE_ENV=production`, `AQUA_ENV=production`, `AQUA_ENV=staging`.
 *   3. Everything else (dev, test) defaults to non-authoritative so the
 *      historical local workflows keep working.
 */

/**
 * Environment surface the resolver reads. `NodeJS.ProcessEnv` satisfies
 * this structurally, and tests can pass narrow literal objects without
 * casting.
 */
export interface DbMigrateAuthorityEnv {
  readonly DB_MIGRATE_AUTHORITATIVE?: string;
  readonly DB_MIGRATE_DDL_AUTHORITY?: string;
  readonly NODE_ENV?: string;
  readonly AQUA_ENV?: string;
  readonly [key: string]: string | undefined;
}

/**
 * Minimal `ConfigService`-shaped reader so the resolver can be used from
 * Nest factories without importing `@nestjs/config` here (keeps this
 * module dependency-free and usable from the db-migrate CLI).
 */
export interface DbMigrateAuthorityConfigReader {
  get<T = string>(key: string, defaultValue?: T): T | undefined;
}

export interface RuntimeDdlAssertionOptions {
  /** Lowercase service tag for the error message (grep-consistency). */
  serviceName: string;
  /** Human-readable DDL operation name, e.g. "RLS schema auto-apply". */
  operation: string;
  /** Injectable for tests; defaults to `process.env`. */
  env?: DbMigrateAuthorityEnv;
}

/**
 * Strict parse of the explicit `DB_MIGRATE_AUTHORITATIVE` value.
 * Returns `undefined` when unset/blank so the caller falls through to
 * the environment default; THROWS on any other malformed value.
 */
function parseExplicitAuthoritative(value: string | undefined): boolean | undefined {
  if (value === undefined || value.trim().length === 0) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;

  throw new Error(
    `DB_MIGRATE_AUTHORITATIVE must be either "true" or "false"; received "${value}".`,
  );
}

/**
 * Resolve whether `aqua-db-migrate` is the authoritative schema-DDL
 * writer for this process. See the module docblock for the contract.
 */
export function resolveDbMigrateAuthoritative(env: DbMigrateAuthorityEnv = process.env): boolean {
  const explicit = parseExplicitAuthoritative(env['DB_MIGRATE_AUTHORITATIVE']);
  if (explicit !== undefined) {
    return explicit;
  }

  const nodeEnv = env['NODE_ENV'] ?? 'development';
  const aquaEnv = env['AQUA_ENV'] ?? nodeEnv;

  return nodeEnv === 'production' || aquaEnv === 'production' || aquaEnv === 'staging';
}

/**
 * Historical name for {@link resolveDbMigrateAuthoritative}, kept as an
 * alias (NOT a second implementation) because five app.modules and the
 * admin-billing runtime-contract invariant reference it. Same function
 * object — strict-parse semantics included.
 */
export const isSchemaDdlOwnedByDbMigrate = resolveDbMigrateAuthoritative;

/**
 * True only inside the `aqua-db-migrate` container, which exports
 * `DB_MIGRATE_DDL_AUTHORITY=1` at entrypoint (apps/db-migrate/src/main.ts).
 * Runtime services must never carry this env — `createServiceTypeOrmConfig`
 * hard-fails if they do.
 */
export function hasDbMigrateDdlAuthority(env: DbMigrateAuthorityEnv = process.env): boolean {
  return env['DB_MIGRATE_DDL_AUTHORITY'] === '1';
}

/**
 * Resolve authority through a `ConfigService`-like reader. Used by Nest
 * factories (`createServiceTypeOrmConfig`, `createSchemaVersionGate`)
 * that read configuration through `ConfigService` rather than raw env so
 * test scaffolding can stub values.
 */
export function resolveDbMigrateAuthoritativeFromConfig(
  configService: DbMigrateAuthorityConfigReader,
): boolean {
  return resolveDbMigrateAuthoritative({
    DB_MIGRATE_AUTHORITATIVE: configService.get<string>('DB_MIGRATE_AUTHORITATIVE'),
    NODE_ENV: configService.get<string>('NODE_ENV', process.env['NODE_ENV'] ?? 'development'),
    AQUA_ENV: configService.get<string>(
      'AQUA_ENV',
      configService.get<string>('NODE_ENV', process.env['NODE_ENV'] ?? 'development'),
    ),
  });
}

/**
 * Choke-point assertion for runtime DDL paths.
 *
 * WHAT: throws when the process is in authoritative mode (db-migrate owns
 * schema DDL) and is NOT the db-migrate container itself. Bootstraps that
 * would issue DDL (`RlsSchemaBootstrap`, `TenantRlsSyncService`,
 * `AuditColumnsBootstrap` via its helper) call this BEFORE opening a
 * QueryRunner so an authoritative deployment fails fast and loud instead
 * of logging a swallowed bootstrap failure.
 *
 * WHY the `[db-migrate authority]` marker: `AuditColumnsBootstrap`
 * rethrows (instead of log-and-continue) exactly when the failure is an
 * authority violation, and it recognises that class by this marker.
 */
export function assertRuntimeDdlAllowed({
  serviceName,
  operation,
  env = process.env,
}: RuntimeDdlAssertionOptions): void {
  if (hasDbMigrateDdlAuthority(env)) {
    // The db-migrate container is the one legitimate DDL writer; its
    // hardening executor reuses the same helpers runtime services are
    // barred from.
    return;
  }
  if (!resolveDbMigrateAuthoritative(env)) {
    return;
  }

  throw new Error(
    `[db-migrate authority] SECURITY: Runtime DDL operation "${operation}" is not allowed for ` +
      `"${serviceName}" when DB_MIGRATE_AUTHORITATIVE=true. ` +
      `aqua-db-migrate is the schema SOT; move this DDL into migrations or ` +
      `SCHEMA_REGISTRY.postMigrationHardening.`,
  );
}
