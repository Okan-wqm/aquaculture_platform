import { Logger, Type } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { TypeOrmModuleOptions } from '@nestjs/typeorm';
import type { EntitySchema, MixedList } from 'typeorm';

import {
  hasDbMigrateDdlAuthority,
  resolveDbMigrateAuthoritativeFromConfig,
} from './db-migrate-authority.util';
import { MIGRATION_LEDGER_TABLE } from './migration-ledger';
import { buildDatabaseSslConfig } from './ssl-config';

/**
 * TypeORM accepts arrays OR map-of-T as inputs to entities/migrations/
 * subscribers. Re-using its native `MixedList<T>` keeps our factory
 * surface aligned with what TypeORM actually consumes — no `as` casts
 * are required at the boundary.
 */
type EntityInput = Type<unknown> | EntitySchema | string;
type MigrationInput = Type<unknown> | string;
type SubscriberInput = Type<unknown> | string;

/**
 * What TypeORM still reports when full query logging is withheld: the things
 * an operator needs and that do not scale with traffic.
 */
const PRODUCTION_SAFE_LOGGING: ('error' | 'warn' | 'migration' | 'schema')[] = [
  'error',
  'warn',
  'migration',
  'schema',
];

/**
 * Resolve TypeORM's `logging` option, refusing to log every statement in
 * production unless an operator says so in a variable that names the risk.
 *
 * WHY: `DATABASE_LOGGING=true` logs one line per SQL statement. Services here
 * poll their outbox continuously, so on 2026-08-15 auth-service alone emitted
 * ~1.9 lines/second — roughly 164k lines a day — and the container log grew to
 * 960 MB, filling the production disk. Nothing was wrong with the data: the
 * volume was pure statement echo. The knob is genuinely useful while debugging,
 * so it is not removed; it simply stops being something a single `true` can
 * leave switched on in production forever. The escape hatch is deliberately
 * long and self-describing, because the person typing it should have to say
 * what they are doing.
 */
export function resolveDatabaseLogging(
  configService: ConfigService,
): boolean | ('error' | 'warn' | 'migration' | 'schema')[] {
  const requested = configService.get('DATABASE_LOGGING', 'false') === 'true';
  if (!requested) return false;

  const isProduction = configService.get('NODE_ENV', 'development') === 'production';
  const acknowledged =
    configService.get('DATABASE_QUERY_LOGGING_ALLOW_IN_PRODUCTION', 'false') === 'true';
  if (isProduction && !acknowledged) {
    new Logger('TypeORM').warn(
      'DATABASE_LOGGING=true is ignored for query logging in production: per-statement logs ' +
        'grow without bound and have filled the disk before. Errors, warnings, migrations and ' +
        'schema events are still logged. Set DATABASE_QUERY_LOGGING_ALLOW_IN_PRODUCTION=true ' +
        'to opt in deliberately, and turn it back off when the investigation ends.',
    );
    return PRODUCTION_SAFE_LOGGING;
  }
  return true;
}

/**
 * =============================================================================
 * Service-level TypeORM configuration factory  (INFRA-DB-POOL-001)
 * =============================================================================
 *
 * Single source of truth for the `TypeOrmModule.forRootAsync` payload that
 * every backend service consumes. Before this factory existed, each service
 * hand-rolled the same ~40 lines of TypeORM bootstrap inside its own
 * `app.module.ts`, leading to:
 *
 *   - Three different env-var names for the same setting
 *     (`DATABASE_POOL_SIZE`, `DB_POOL_SIZE`, `DATABASE_POOL_MAX`).
 *   - Pool defaults that ranged from 5 to 50 with no documented rationale.
 *   - `extra.options` strings copy-pasted with per-service search_path
 *     tweaks that were easy to mis-edit.
 *   - SSL bootstrap duplicated in every service (with subtle drift —
 *     some services threw on production-without-CA, some only warned).
 *   - No place to add a new database knob (e.g. RDS Proxy endpoint
 *     switch in INFRA-DB-POOL-001 Track B) without touching 13 files.
 *
 * The factory lifts the duplication into one explicit, parameterised call.
 * Services that need a non-default pool size (admin-api, MEDIUM-007 fix)
 * pass `defaultPoolSize` with a comment explaining WHY at the call site —
 * the justification lives next to the override, not buried deep in code.
 *
 * # Environment variable contract
 *
 *   DATABASE_HOST                       host                    default localhost
 *   DATABASE_PORT                       port (number)           default 5432
 *   DATABASE_USER                       username                default postgres
 *   DATABASE_PASSWORD                   password (required in production — fail-fast)
 *   DATABASE_NAME                       database name           default aquaculture
 *   DATABASE_LOGGING                    "true" / "false"        default false
 *                                       (in production this enables error/warn/migration/
 *                                        schema logging only — see resolveDatabaseLogging)
 *   DATABASE_QUERY_LOGGING_ALLOW_IN_PRODUCTION  opt in to per-statement logs in production
 *   DATABASE_POOL_SIZE                  pg pool max             default 10 (or `defaultPoolSize` opt)
 *   DATABASE_POOL_MIN                   pg pool min             default 2
 *   DATABASE_POOL_IDLE_TIMEOUT_MS       pg idle timeout (ms)    default 30000
 *   DATABASE_POOL_CONNECTION_TIMEOUT_MS pg connect timeout (ms) default 5000
 *   DATABASE_SSL                        "true" enables TLS       (see ssl-config.ts)
 *   DATABASE_SSL_CA                     filesystem path to CA   (see ssl-config.ts)
 *   DATABASE_SSL_REJECT_UNAUTHORIZED    "true" / "false"         (see ssl-config.ts)
 *
 * Pool size is bounded by the connection-budget invariant documented in
 * `docs/runbooks/database-capacity.md`:
 *
 *   sum(per-service DATABASE_POOL_SIZE) × max(replica count) < max_connections × 0.7
 *
 * The CI script `tools/scripts/database/capacity-check.sh` enforces the
 * invariant by parsing this factory's `defaultPoolSize` arguments.
 *
 * # Why `schema` is NOT applied as a TypeORM `schema:` option
 *
 * Setting `schema:` causes TypeORM to inject explicit schema prefixes into
 * every query, overriding the per-request `search_path` set by
 * `TenantConnectionBootstrap` (`tenant-connection-bootstrap.service.ts`).
 * That breaks multi-tenant isolation. Instead we set the default
 * `search_path` via the pg driver's `options:` param so:
 *
 *   1. CLI / migration / bootstrap connections (no request context) land on
 *      the source schema.
 *   2. Per-request connections get overridden by the bootstrap's
 *      `SET search_path TO <tenant>,<source>,public` on every checkout.
 *
 * # Why `migrationsRun` defaults to `false`
 *
 * The platform standard is the per-service `MigrationRunnerService`
 * factory (`migration-runner/`) which enforces a search_path invariant
 * around each migration and hard-fails in production when
 * `DATABASE_MIGRATIONS_RUN=false`. TypeORM's built-in `migrationsRun:true`
 * skips those guardrails, so it is opt-in via the `migrationsRun` factory
 * argument and only auth-service currently uses it (legacy).
 *
 * # Why `synchronize` is always false
 *
 * Runtime TypeORM synchronize is not a configuration option. DDL belongs to
 * db-migrate / migration runners only. `DATABASE_SYNC=true` is accepted only as
 * a fail-fast misconfiguration signal so old compose/env files cannot silently
 * re-enable a second schema writer.
 */

export interface ServiceTypeOrmOptions {
  /**
   * Short service identifier used in error messages and logger contexts.
   * E.g. 'farm', 'sensor', 'auth'. Keep lowercase, no suffix.
   */
  serviceName: string;

  /**
   * Source schema that owns this service's tables. Becomes the default
   * `search_path` for connections without a request context (migrations,
   * bootstrap, TypeORM CLI). Per-request connections override this via
   * `TenantConnectionBootstrap`.
   */
  schema: string;

  /**
   * Migrations for this service. Either class references (preferred — webpack
   * bundles them so `dist/migrations/*.js` glob would match zero files at
   * runtime) OR a glob path string for tsc-built services.
   */
  migrations: MixedList<MigrationInput>;

  /**
   * Optional explicit entity list. Default is `autoLoadEntities: true`
   * which picks up everything imported via `TypeOrmModule.forFeature`.
   * Override only when a service has entities outside the forFeature graph.
   */
  entities?: MixedList<EntityInput>;

  /**
   * Service-specific override of the platform default pool size (10).
   * MUST be paired with a call-site comment explaining the contention
   * evidence. Example: admin-api uses 40 because its dashboard fans out
   * 5 parallel metric queries (MEDIUM-007).
   *
   * Operators can override at deploy time via the `DATABASE_POOL_SIZE`
   * env var; the call-site `defaultPoolSize` only sets a higher floor.
   */
  defaultPoolSize?: number;

  /**
   * Service-specific override of the platform default pool MIN (2). Most
   * services do not need to touch this.
   */
  defaultPoolMin?: number;

  /**
   * Service-specific override of the platform default idle timeout
   * (30000 ms). Use a longer value for services with continuous-ingestion
   * workloads where letting connections drop and re-handshake adds
   * noticeable latency (e.g. sensor-service @ 5 min for MQTT ingest).
   */
  defaultPoolIdleTimeoutMs?: number;

  /**
   * Service-specific pool acquisition deadline. Continuous ingress services
   * use this to fail early enough to preserve their upstream ACK budget.
   */
  defaultPoolConnectionTimeoutMs?: number;

  /**
   * TypeORM EventSubscriber classes (e.g. AuditSubscriber). Optional
   * because most services do not register subscribers; passing it through
   * as a factory option keeps the call site explicit instead of leaking
   * subscriber configuration into the factory.
   */
  subscribers?: MixedList<SubscriberInput>;

  /**
   * Use TypeORM's built-in migration runner (`true`) or defer to the
   * `MigrationRunnerService` factory provider in this service's app
   * module (`false`, default). Only auth-service uses `true` today.
   */
  migrationsRun?: boolean;

  /**
   * Conditional override for `migrationsRun` based on env. Provided as a
   * function so the factory can evaluate against the running ConfigService
   * without leaking ConfigService into the call site twice. Mutually
   * exclusive with `migrationsRun`.
   */
  migrationsRunFromEnv?: (configService: ConfigService) => boolean;

  /**
   * Additional pg driver `extra` keys merged AFTER the factory defaults,
   * giving call sites a defined extension surface without forcing a fork
   * of the whole `extra:` block. Use sparingly — every key here is a
   * spot of drift waiting to happen.
   */
  extraOptions?: Record<string, unknown>;
}

/**
 * Build the TypeOrmModule.forRootAsync `useFactory` payload for one service.
 *
 * @example
 * ```ts
 * TypeOrmModule.forRootAsync({
 *   imports: [ConfigModule],
 *   inject: [ConfigService],
 *   useFactory: (configService: ConfigService) =>
 *     createServiceTypeOrmConfig(configService, {
 *       serviceName: 'farm',
 *       schema: 'farm',
 *       migrations: [AddSystemHierarchy1734336000000, ...]
 *     }),
 * }),
 * ```
 *
 * @example Service-specific pool override with documented reason
 * ```ts
 * useFactory: (configService: ConfigService) =>
 *   createServiceTypeOrmConfig(configService, {
 *     serviceName: 'admin-api',
 *     schema: 'admin',
 *     migrations: [...],
 *     // MEDIUM-007: dashboard fans out 5 parallel metric queries; 10 was
 *     // tight under concurrent superadmin sessions. Validated at 40 in
 *     // 2026-Q1. Operators may further raise via DATABASE_POOL_SIZE env.
 *     defaultPoolSize: 40,
 *   }),
 * ```
 */
export function createServiceTypeOrmConfig(
  configService: ConfigService,
  opts: ServiceTypeOrmOptions,
): TypeOrmModuleOptions {
  if (opts.migrationsRun !== undefined && opts.migrationsRunFromEnv !== undefined) {
    throw new Error(
      `[${opts.serviceName}] createServiceTypeOrmConfig: pass either migrationsRun OR migrationsRunFromEnv, not both`,
    );
  }

  // SECURITY: fail-fast in production if the password is missing. We check
  // process.env directly here (instead of configService.get) so a forgotten
  // ConfigModule.forRoot wiring cannot mask the requirement.
  const dbPassword = configService.get<string>('DATABASE_PASSWORD');
  if (!dbPassword && process.env['NODE_ENV'] === 'production') {
    throw new Error(
      `SECURITY: DATABASE_PASSWORD must be set in production (service=${opts.serviceName})`,
    );
  }

  const migrationsRun =
    opts.migrationsRunFromEnv != null
      ? opts.migrationsRunFromEnv(configService)
      : (opts.migrationsRun ?? false);
  const nodeEnv = process.env['NODE_ENV'];
  // SSOT resolution (PR#363 design): authority comes from the shared
  // strict-parse resolver — a malformed DB_MIGRATE_AUTHORITATIVE value
  // throws here, at DataSource-config time, before any pool is opened.
  const dbMigrateAuthoritative = resolveDbMigrateAuthoritativeFromConfig(configService);
  const retiredDatabaseSync = configService.get<string>('DATABASE_SYNC');
  if (hasDbMigrateDdlAuthority()) {
    throw new Error(
      `[${opts.serviceName}] DB_MIGRATE_DDL_AUTHORITY=1 is only valid inside aqua-db-migrate; ` +
        'runtime services must not receive DDL-authority credentials or env.',
    );
  }
  if (retiredDatabaseSync === 'true') {
    throw new Error(
      `[${opts.serviceName}] DATABASE_SYNC=true is retired. Runtime services must never run ` +
        'TypeORM synchronize; use db-migrate or a reviewed TypeORM migration instead.',
    );
  }

  if (migrationsRun && (nodeEnv === 'production' || dbMigrateAuthoritative)) {
    throw new Error(
      `[${opts.serviceName}] TypeORM migrationsRun=true is not allowed when ` +
        'aqua-db-migrate is the authoritative DDL writer. Set DATABASE_MIGRATIONS_RUN=false.',
    );
  }

  // Hot-path: read env once into a local; ConfigService.get does a string-
  // parse on each call which adds up across 13 services × N reads.
  const poolMax = configService.get<number>(
    'DATABASE_POOL_SIZE',
    opts.defaultPoolSize ?? DEFAULT_POOL_SIZE,
  );
  const poolMin = configService.get<number>(
    'DATABASE_POOL_MIN',
    opts.defaultPoolMin ?? DEFAULT_POOL_MIN,
  );
  const poolIdleTimeoutMs = configService.get<number>(
    'DATABASE_POOL_IDLE_TIMEOUT_MS',
    opts.defaultPoolIdleTimeoutMs ?? DEFAULT_POOL_IDLE_TIMEOUT_MS,
  );
  const poolConnectionTimeoutMs = configService.get<number>(
    'DATABASE_POOL_CONNECTION_TIMEOUT_MS',
    opts.defaultPoolConnectionTimeoutMs ?? DEFAULT_POOL_CONNECTION_TIMEOUT_MS,
  );

  const logging = resolveDatabaseLogging(configService);

  // Defensive log on every bootstrap so capacity drift is greppable.
  // Single line per service keeps it cheap; structured fields make it
  // amenable to log-based dashboards.
  new Logger(`TypeORM(${opts.serviceName})`).log(
    `pool max=${poolMax} min=${poolMin} schema=${opts.schema} migrationsRun=${migrationsRun} ` +
      `logging=${Array.isArray(logging) ? logging.join('|') : logging}`,
  );

  return {
    type: 'postgres',
    host: configService.get('DATABASE_HOST', 'localhost'),
    port: configService.get<number>('DATABASE_PORT', 5432),
    username: configService.get('DATABASE_USER', 'postgres'),
    password: dbPassword || 'postgres',
    database: configService.get('DATABASE_NAME', 'aquaculture'),
    // INTENTIONAL: do NOT set `schema` — see factory docblock §"Why schema is NOT applied".
    autoLoadEntities: opts.entities == null,
    entities: opts.entities,
    subscribers: opts.subscribers,
    synchronize: false,
    migrationsRun,
    migrations: opts.migrations,
    migrationsTableName: MIGRATION_LEDGER_TABLE,
    logging,
    ssl: buildDatabaseSslConfig(configService),
    extra: {
      max: poolMax,
      min: poolMin,
      idleTimeoutMillis: poolIdleTimeoutMs,
      connectionTimeoutMillis: poolConnectionTimeoutMs,
      // Default search_path covers no-context connections (CLI, migrations,
      // bootstrap). Per-request connections are overridden on checkout by
      // TenantConnectionBootstrap.
      options: `-c search_path=${opts.schema},public`,
      ...opts.extraOptions,
    },
  };
}

// -----------------------------------------------------------------------------
// Defaults
// -----------------------------------------------------------------------------

/**
 * Platform default pool max. Sized so 13 services × 10 = 130 connections
 * fits comfortably below the droplet `max_connections=300` and leaves
 * headroom for migrations, bootstrap, and ad-hoc psql sessions. Per-service
 * overrides via `defaultPoolSize` arg or `DATABASE_POOL_SIZE` env var.
 */
export const DEFAULT_POOL_SIZE = 10;

/**
 * Platform default pool min — keeps a warm baseline so the first request
 * after idle does not pay full TLS handshake + auth round-trip latency.
 */
export const DEFAULT_POOL_MIN = 2;

/**
 * pg driver default is 10 seconds. We tighten to 30s instead of leaving
 * the default 10s because some long-lived idle connections (the
 * outbox-notify listener) intentionally sleep on LISTEN.
 */
export const DEFAULT_POOL_IDLE_TIMEOUT_MS = 30_000;

/**
 * Connection acquisition timeout. 5 seconds is generous for a healthy
 * cluster and short enough to fail fast when the pool is exhausted (so
 * the request's own deadline error fires before the upstream LB times
 * us out).
 */
export const DEFAULT_POOL_CONNECTION_TIMEOUT_MS = 5_000;
