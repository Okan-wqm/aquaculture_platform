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
 * The real pg.Pool exposes ~30 methods; we declare the surface
 * the bootstraps actually use. Adding a method requires a
 * conscious extension of this interface — keeping the surface
 * narrow makes it impossible to accidentally rely on driver
 * internals.
 *
 * # Why `connect` carries two call shapes
 *
 * pg.Pool exposes TWO connect overloads at runtime: a Promise-
 * returning parameterless form, and a callback-style form
 * `connect(cb: (err, client, done) => void): void`. The
 * connection-bootstrap services patch `pool.connect` itself
 * (assignment) to inject SET search_path / SET app.current_tenant
 * on every checked-out connection, so the field MUST be:
 *
 *   - assignable (not readonly), and
 *   - a function value that supports BOTH call shapes.
 *
 * Modeling that as a TypeScript function type with overloads
 * gives the bootstraps the call-shape flexibility they need
 * without pulling in pg's full PoolClient types (which would
 * leak the Pool's other ~28 unused methods into our narrow
 * surface).
 */
type PgPoolConnectCallback = (
  err: Error | null,
  client?: PgPoolClientLike,
  done?: (release?: unknown) => void,
) => void;

export interface PgPoolConnectFn {
  (): Promise<PgPoolClientLike>;
  (callback: PgPoolConnectCallback): void;
  bind(thisArg: unknown): PgPoolConnectFn;
}

export interface PgPoolLike {
  /**
   * Acquire a client from the pool. The returned PoolClient is
   * a query-capable handle; the bootstraps wrap this method to
   * inject SET search_path / SET app.current_tenant on every
   * checked-out connection.
   *
   * Writable so the bootstraps can assign a wrapped function back
   * to the pool — that's how the search_path / RLS GUC injection
   * fires on every checkout.
   */
  connect: PgPoolConnectFn;
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
 * THROWS when the driver exposes no usable `master` pool.
 *
 * # Why it throws rather than returning null
 *
 * It used to return null, on the stated reasoning that "the bootstraps catch
 * the missing-pool case at boot and refuse to start the service". Neither
 * bootstrap did. Both wrote `logger.error(...)` and `return`, so the pool patch
 * silently became a no-op and the service booted anyway:
 *
 *   - `RlsConnectionBootstrap` — `app.current_tenant` is then never set on a
 *     checked-out connection, so `tenant_isolation_policy` sees an unset GUC.
 *   - `TenantConnectionBootstrap` — `search_path` is then never set per
 *     checkout, so a schema-per-tenant service stops routing to
 *     `tenant_<uuid>` and runs against whatever the connection default is.
 *
 * Both are load-bearing for tenant isolation, both are invisible at boot (one
 * ERROR line among hundreds), and both were contradicted by every docblock
 * describing them: this file said "refuse to start the service",
 * `rls.module.ts` said "throws an actionable error at boot", and
 * `rls.module.spec.ts` asserted `rejects.toThrow(/REMEDIATION/)`. That spec
 * lives in `libs/backend-common`, which had no Nx project and therefore no CI
 * lane — nothing ran it, so the divergence stood.
 *
 * Returning null was the mechanism that made "degrade quietly" expressible at
 * all. Removing the null makes booting with an unpatched pool structurally
 * impossible instead of merely discouraged, and the two callers can no longer
 * drift apart on how they handle it, because there is nothing left to handle.
 *
 * @param context - caller tag for the failure message (e.g. `'RlsConnectionBootstrap[billing]'`)
 * @throws Error naming the context, with a REMEDIATION: clause
 */
export function getPgPoolFromDataSource(
  dataSource: DataSource,
  context: string,
): PgPoolLike {
  // The cast is the SINGLE place in the codebase where TypeORM's
  // private driver shape is bridged to the typed surface. Every
  // other callsite in the codebase imports getPgPoolFromDataSource
  // — the no-driver-cast-as-any invariant catches drift.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const driver = dataSource.driver as unknown as DriverWithPool;
  const pool = driver.master;
  if (!pool || typeof pool.connect !== 'function') {
    throw new Error(
      `[${context}] pg Pool not found on the TypeORM DataSource driver, so the ` +
        `connection-pool patch that carries tenant isolation (search_path and/or ` +
        `the app.current_tenant GUC) cannot be installed. Booting without it ` +
        `would leave tenant routing inactive for every query this service makes. ` +
        `REMEDIATION: register this module only in a service whose imports graph ` +
        `provides a PostgreSQL DataSource via TypeOrmModule.forRoot/forRootAsync — ` +
        `a non-pg driver or a stub DataSource cannot carry tenant isolation.`,
    );
  }
  return pool;
}
