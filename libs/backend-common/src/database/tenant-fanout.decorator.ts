/**
 * @TenantFanOut + @AllowTenantDelta + @SourceOnlyMigration — migration-class
 * metadata for the orchestrator's tenant fan-out logic.
 * ============================================================================
 *
 * Plan v3 R21 + R24. Two small, composable decorators that let
 * migration authors declare runtime properties the orchestrator + the
 * drift validator consume:
 *
 *   @TenantFanOut({ lockClass, concurrency })
 *     - lockClass = 'catalog'  → force concurrency 1 (PG catalog mutex;
 *                                e.g. ALTER TYPE ADD VALUE serializes on
 *                                pg_type regardless of tenant count).
 *     - lockClass = 'tenant-local' → parallel fan-out up to `concurrency`.
 *     - concurrency caps the per-schema parallelism cap for tenant-local
 *       classes. Default 8.
 *
 *   @AllowTenantDelta({ columnPrefix })
 *     - Tenants allowed to carry additional columns whose names start
 *       with the listed prefixes. Class I (per-tenant shape divergence)
 *       suppresses false-positives when a tenant's extra columns match
 *       this allowlist. Typical use: `'enterprise_'` prefix for
 *       tenant-scoped enterprise-tier customizations.
 *
 *   @SourceOnlyMigration({ reason })
 *     - migration runs only on the service source schema.
 *     - tenant ledgers record it as source-only skipped so it does not stay
 *       pending forever.
 *     - use for infrastructure tables such as `<service>_outbox` that are
 *       deliberately not cloned into tenant_<uuid> schemas.
 *
 * # Why decorators on the MIGRATION CLASS, not config?
 *
 * Fan-out + allowlist semantics belong WITH the migration that introduces
 * them. A config file ~10 levels removed from the SQL it governs drifts;
 * a `@TenantFanOut` on the migration class co-locates the decision with
 * the code that makes it load-bearing. The orchestrator reads the
 * metadata via reflect-metadata, the same pattern used for
 * @ExpandContract + @EncryptedAtRest.
 *
 * # Runtime consumption
 *
 * The orchestrator's tenant fan-out loop (Phase 6) queries
 * `getTenantFanOutMetadata(migrationClass)` before scheduling work.
 * `null` → default (tenant-local, concurrency 8).
 *
 * SchemaDriftValidator Class I check consults
 * `getAllowedTenantDeltaPrefixes(entityClass)` when diffing tenant
 * vs source shape; matched-prefix columns are suppressed.
 */
import 'reflect-metadata';

export const TENANT_FANOUT_META_KEY = Symbol.for(
  '@aquaculture/backend-common:tenant-fanout',
);
export const ALLOW_TENANT_DELTA_META_KEY = Symbol.for(
  '@aquaculture/backend-common:allow-tenant-delta',
);
export const SOURCE_ONLY_MIGRATION_META_KEY = Symbol.for(
  '@aquaculture/backend-common:source-only-migration',
);

type DecoratedClassTarget = Parameters<ClassDecorator>[0];

export type TenantLockClass = 'catalog' | 'tenant-local';

export interface TenantFanOutOptions {
  /**
   * catalog  = PG catalog mutex applies (ALTER TYPE ADD VALUE, CREATE TYPE,
   *            CREATE EXTENSION). Forced concurrency 1 — the orchestrator
   *            runs one tenant at a time even if concurrency > 1 was set.
   * tenant-local = per-tenant DDL with no cross-tenant catalog serialization.
   *                Orchestrator may fan out up to `concurrency` in parallel.
   */
  readonly lockClass: TenantLockClass;
  /** Default 8. Clamped to [1, 32] by getTenantFanOutMetadata(). */
  readonly concurrency?: number;
  /**
   * Optional free-form note for operator review (incident ID, rationale).
   * Surfaces in orchestrator logs.
   */
  readonly reason?: string;
}

export interface TenantFanOutMetadata extends TenantFanOutOptions {
  /** Resolved concurrency after clamp + catalog-class override. */
  readonly effectiveConcurrency: number;
  /** Original migration class for debug attribution. */
  readonly target: DecoratedClassTarget;
}

/**
 * Class decorator on a MigrationInterface class.
 *
 * @throws RangeError on invalid lockClass or out-of-range concurrency.
 */
export function TenantFanOut(opts: TenantFanOutOptions): ClassDecorator {
  if (opts.lockClass !== 'catalog' && opts.lockClass !== 'tenant-local') {
    throw new RangeError(
      `@TenantFanOut: lockClass must be 'catalog' | 'tenant-local' (got '${String(opts.lockClass)}')`,
    );
  }
  if (opts.concurrency !== undefined) {
    if (
      !Number.isFinite(opts.concurrency) ||
      opts.concurrency < 1 ||
      opts.concurrency > 32
    ) {
      throw new RangeError(
        `@TenantFanOut: concurrency must be an integer in [1, 32] (got ${opts.concurrency})`,
      );
    }
  }
  return (target): void => {
    Reflect.defineMetadata(TENANT_FANOUT_META_KEY, { ...opts, target }, target);
  };
}

/**
 * Resolve the effective fan-out policy for a class:
 *   - returns null when undecorated (caller applies defaults)
 *   - forces concurrency 1 for lockClass='catalog' regardless of
 *     the declared value (catalog mutex doesn't get faster by adding
 *     workers; plan v3 R21 documents this is where concurrency=8
 *     "theatre" was happening in the old orchestrator)
 *   - clamps tenant-local concurrency to [1, 32]
 */
export function getTenantFanOutMetadata(
  ctor: DecoratedClassTarget,
): TenantFanOutMetadata | null {
  const raw = Reflect.getMetadata(TENANT_FANOUT_META_KEY, ctor) as
    | (TenantFanOutOptions & { target?: DecoratedClassTarget })
    | undefined;
  if (!raw) return null;
  const declared = raw.concurrency ?? 8;
  const effectiveConcurrency =
    raw.lockClass === 'catalog' ? 1 : Math.max(1, Math.min(32, declared));
  return {
    lockClass: raw.lockClass,
    concurrency: declared,
    ...(raw.reason !== undefined ? { reason: raw.reason } : {}),
    effectiveConcurrency,
    target: ctor,
  };
}

// --------------------------------------------------------------------
// @AllowTenantDelta
// --------------------------------------------------------------------

export interface AllowTenantDeltaOptions {
  /**
   * Column-name prefixes tolerated on tenant_* schemas for this entity.
   * Case-sensitive; matches via startsWith. Non-prefixed columns still
   * count as drift.
   */
  readonly columnPrefix: readonly string[];
  readonly reason?: string;
}

export interface AllowTenantDeltaMetadata extends AllowTenantDeltaOptions {
  readonly target: DecoratedClassTarget;
}

/**
 * Class decorator on an @Entity class.
 */
export function AllowTenantDelta(
  opts: AllowTenantDeltaOptions,
): ClassDecorator {
  if (!Array.isArray(opts.columnPrefix) || opts.columnPrefix.length === 0) {
    throw new TypeError(
      `@AllowTenantDelta: columnPrefix must be a non-empty readonly string[]`,
    );
  }
  for (const p of opts.columnPrefix) {
    if (typeof p !== 'string' || p.length === 0) {
      throw new TypeError(
        `@AllowTenantDelta: every columnPrefix entry must be a non-empty string (got ${JSON.stringify(p)})`,
      );
    }
  }
  return (target): void => {
    Reflect.defineMetadata(
      ALLOW_TENANT_DELTA_META_KEY,
      { ...opts, target },
      target,
    );
  };
}

/**
 * Returns the allowed column prefix list for the entity class, or an
 * empty array when undecorated. Safe to call unconditionally from the
 * Class I drift check.
 */
export function getAllowedTenantDeltaPrefixes(
  ctor: DecoratedClassTarget,
): readonly string[] {
  const raw = Reflect.getMetadata(ALLOW_TENANT_DELTA_META_KEY, ctor) as
    | AllowTenantDeltaMetadata
    | undefined;
  return raw?.columnPrefix ?? [];
}

/**
 * Convenience: does a tenant column name match any allowed prefix?
 */
export function isTenantDeltaAllowed(
  ctor: DecoratedClassTarget,
  columnName: string,
): boolean {
  const prefixes = getAllowedTenantDeltaPrefixes(ctor);
  if (prefixes.length === 0) return false;
  return prefixes.some((p) => columnName.startsWith(p));
}

// --------------------------------------------------------------------
// @SourceOnlyMigration
// --------------------------------------------------------------------

export interface SourceOnlyMigrationOptions {
  readonly reason: string;
}

export interface SourceOnlyMigrationMetadata extends SourceOnlyMigrationOptions {
  readonly target: DecoratedClassTarget;
}

export function SourceOnlyMigration(
  opts: SourceOnlyMigrationOptions,
): ClassDecorator {
  if (typeof opts.reason !== 'string' || opts.reason.trim().length === 0) {
    throw new TypeError(
      '@SourceOnlyMigration: reason must be a non-empty string',
    );
  }
  return (target): void => {
    Reflect.defineMetadata(
      SOURCE_ONLY_MIGRATION_META_KEY,
      { ...opts, target },
      target,
    );
  };
}

export function getSourceOnlyMigrationMetadata(
  ctor: DecoratedClassTarget,
): SourceOnlyMigrationMetadata | null {
  const raw = Reflect.getMetadata(SOURCE_ONLY_MIGRATION_META_KEY, ctor) as
    | SourceOnlyMigrationMetadata
    | undefined;
  return raw ?? null;
}

export function isSourceOnlyMigration(ctor: DecoratedClassTarget): boolean {
  return getSourceOnlyMigrationMetadata(ctor) !== null;
}
