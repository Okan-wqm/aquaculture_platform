import type { DataSource } from 'typeorm';

/**
 * Typed accessor for the underlying pg Pool that TypeORM hides
 * inside its driver implementation. Centralises the
 * driver-internal `master` lookup that ALL connection-bootstrap
 * services need (DATA-LOW-001 cure).
 *
 * # Why this exists
 *
 * Pre-cure two services (TenantConnectionBootstrap +
 * RlsConnectionBootstrap) each grabbed the pool via
 * `dataSource.driver as any` because TypeORM's `Driver` interface
 * does not expose `master` (the pg.Pool reference) on its public
 * surface. Both call sites were CLAUDE.md `as any` violations
 * marked LOW because they're true boundary patterns — not bugs,
 * just a typed adapter missing.
 *
 * The audit's recommendation:
 *
 *   > write a thin typed adapter (`PgPoolFromDataSource(ds): pg.Pool`)
 *   > once, hide the `as any` inside it.
 *
 * This module IS that adapter. Future bootstraps that need pg.Pool
 * access call this helper instead of duplicating the `as any`
 * pattern; new ad-hoc `dataSource.driver as any` lookups in
 * application code are caught by the
 * `tests/invariants/no-driver-cast-as-any.spec.ts` invariant
 * (added alongside) which lets the bootstrap services themselves
 * import via this util but flags any other callsite.
 *
 * # Why not extend the TypeORM type?
 *
 * Extending `DataSource['driver']` via module augmentation would
 * leak the internal-shape contract platform-wide. The narrow
 * `PgPoolLike` here exposes ONLY the `connect()` method the
 * bootstrap services actually need — Tier-1 "make it impossible"
 * to accidentally use unrelated driver internals.
 */

/**
 * Minimal pg.Pool surface the connection bootstraps consume.
 *
 * The real pg.Pool exposes ~30 methods; we declare the two the
 * bootstraps actually use. Adding a third method requires a
 * conscious extension of this interface — keeping the surface
 * narrow makes it impossible to accidentally rely on driver
 * internals.
 */
export interface PgPoolLike {
  /**
   * Acquire a client from the pool. The returned PoolClient is
   * a query-capable handle; the bootstraps wrap this method to
   * inject SET search_path / SET app.current_tenant on every
   * checked-out connection.
   */
  connect(): Promise<PgPoolClientLike>;
}

/**
 * Minimal pg.PoolClient surface — the shape the bootstrap
 * connect-wrapper closures need to set the per-connection GUC
 * variables and release back to the pool.
 */
export interface PgPoolClientLike {
  query: (text: string, values?: unknown[]) => Promise<unknown>;
  release: (err?: Error) => void;
}

/**
 * Internal shape we expect TypeORM's PostgresDriver to expose.
 * Not exported — callers go through `getPgPoolFromDataSource`.
 */
interface DriverWithPool {
  master?: PgPoolLike;
}

/**
 * Extract the underlying pg.Pool from a TypeORM DataSource.
 *
 * Returns null if the driver doesn't expose a `master` property
 * (e.g. non-pg drivers, in-memory test doubles). Callers MUST
 * handle the null case — the bootstrap services emit a
 * boot-blocking error log when null is returned because the
 * connection-pool patch is load-bearing for tenant isolation.
 *
 * # Why returns null instead of throwing
 *
 * The bootstraps catch the missing-pool case at boot and refuse
 * to start the service rather than crashing during the first
 * request. Returning null lets each caller log its own service-
 * specific error message and degrade in its own way.
 */
export function getPgPoolFromDataSource(
  dataSource: DataSource,
): PgPoolLike | null {
  // The cast is the SINGLE place in the codebase where TypeORM's
  // private driver shape is bridged to the typed surface. Every
  // other callsite in the codebase imports getPgPoolFromDataSource
  // — the no-driver-cast-as-any invariant catches drift.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const driver = dataSource.driver as unknown as DriverWithPool;
  const pool = driver.master;
  if (!pool || typeof pool.connect !== 'function') {
    return null;
  }
  return pool;
}
