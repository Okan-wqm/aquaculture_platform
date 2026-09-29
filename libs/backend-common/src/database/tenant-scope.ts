import type { DataSource, EntityManager, EntityTarget, ObjectLiteral, QueryRunner } from 'typeorm';

import { RLS_BYPASS_GUC, RLS_TENANT_GUC } from './rls/apply-tenant-rls.helper';
import { runInTenantRead, runInTenantTransaction } from './tenant-transaction';
import { getTenantSchemaName, isValidUUID } from './tenant-schema.utils';

/** What a scope may do: `read` runs in a READ ONLY transaction, `write` in a read-write one. */
export type TenantScopeAccess = 'read' | 'write';

/**
 * Thrown when code keeps a scope past the boundary that opened it. The
 * connection behind it has been released (and may already serve another
 * tenant), so every use after close is refused.
 */
export class TenantScopeClosedError extends Error {
  constructor() {
    super('This tenant scope is closed; its connection was released when its boundary ended');
    this.name = 'TenantScopeClosedError';
  }
}

interface ServedTenantRow {
  readonly schema?: unknown;
  readonly tenant?: unknown;
  readonly bypass?: unknown;
}

/**
 * The tenant-bound data handle (K10 layer 4 / PR-T1, MT-HIGH-062).
 *
 * WHY a handle instead of "call runInTenantRead yourself": code that holds a
 * `DataSource` or a repository can read on any pooled connection, under any
 * search_path, for any tenant id it happens to hold. Code that holds only a
 * `TenantScope` can read on exactly one connection — the one the boundary
 * pinned to one tenant schema and one RLS tenant, and asserted, before the
 * scope existed.
 *
 * WHAT: `manager` / `query` run on that pinned connection; `tenantId` is the
 * tenant the boundary asserted on it. The constructor is private and the brand
 * is an ES private field, so the only way to hold a genuine scope is to be
 * called by `TenantScope.read` / `TenantScope.write`. The scope is frozen and
 * refuses every use after its boundary ends.
 *
 * INVARIANT: every row read through a scope comes from `tenantId`'s schema
 * under `tenantId`'s RLS setting; if violated → a reply can carry another
 * tenant's rows. Code that could still escape it (a `DataSource`, a
 * repository, schema-qualified SQL, `manager.connection`) is refused on every
 * AI-reachable path by tests/invariants/ai-tenant-boundary-data-layer.spec.ts.
 */
export class TenantScope {
  readonly #runner: QueryRunner;
  #open = true;

  private constructor(
    runner: QueryRunner,
    /** The tenant the boundary pinned AND asserted on this connection. */
    readonly tenantId: string,
    readonly access: TenantScopeAccess,
  ) {
    this.#runner = runner;
    Object.freeze(this);
  }

  /** The EntityManager of the tenant-pinned connection. */
  get manager(): EntityManager {
    this.#assertOpen();
    return this.#runner.manager;
  }

  /**
   * The unqualified table name TypeORM maps `entity` to — entity metadata
   * only, no query. WHY on the scope: code running on it builds raw SQL for
   * registry-driven sources (the finance derived-cost UNION) and must learn a
   * table name without reaching the DataSource (`manager.connection`) or a raw
   * repository, both of which lead outside the pinned connection.
   */
  tableNameOf(entity: EntityTarget<ObjectLiteral>): string {
    this.#assertOpen();
    return this.#runner.connection.getMetadata(entity).tableName;
  }

  /** Raw SQL on the tenant-pinned connection. Table names stay unqualified. */
  async query<T = unknown>(sql: string, parameters?: unknown[]): Promise<T> {
    this.#assertOpen();
    return this.#runner.query(sql, parameters);
  }

  /**
   * The tenant this connection serves RIGHT NOW, read back from the connection.
   *
   * WHY read it again after the handler ran: the boundary asserted the tenant
   * before any domain query, but code inside the scope can still change the
   * transaction-local search_path or RLS setting. The reply must name the
   * tenant whose schema and RLS setting actually served the read, so a
   * responder cannot claim tenant A for rows it read under tenant B.
   *
   * WHAT: the RLS tenant when it is a UUID, `current_schema()` is that
   * tenant's schema and the RLS bypass is off; otherwise null (the connection
   * serves no single tenant — the caller must treat that as a mismatch).
   */
  async readServedTenant(): Promise<string | null> {
    this.#assertOpen();
    const rows: unknown = await this.#runner.query(
      `SELECT current_schema() AS schema,
              current_setting($1, true) AS tenant,
              current_setting($2, true) AS bypass`,
      [RLS_TENANT_GUC, RLS_BYPASS_GUC],
    );
    const row: ServedTenantRow | undefined = Array.isArray(rows) ? rows[0] : undefined;
    if (row === undefined || typeof row.tenant !== 'string' || !isValidUUID(row.tenant)) {
      return null;
    }
    const consistent = row.schema === getTenantSchemaName(row.tenant) && row.bypass === 'off';
    return consistent ? row.tenant : null;
  }

  /** True only for a scope the boundary minted — a structural copy fails. */
  static isGenuine(value: unknown): value is TenantScope {
    return typeof value === 'object' && value !== null && #runner in value;
  }

  /**
   * Open a READ ONLY tenant boundary (`runInTenantRead`) and hand `fn` its scope.
   * The scope closes when `fn` settles.
   */
  static read<T>(
    dataSource: DataSource,
    sourceSchema: string,
    tenantId: string,
    fn: (scope: TenantScope) => Promise<T>,
  ): Promise<T> {
    return runInTenantRead(dataSource, sourceSchema, tenantId, (runner) =>
      TenantScope.#within(runner, tenantId, 'read', fn),
    );
  }

  /**
   * Open a read-write tenant boundary (`runInTenantTransaction`) and hand `fn`
   * its scope. Commits when `fn` resolves, rolls back when it throws.
   */
  static write<T>(
    dataSource: DataSource,
    sourceSchema: string,
    tenantId: string,
    fn: (scope: TenantScope) => Promise<T>,
  ): Promise<T> {
    return runInTenantTransaction(dataSource, sourceSchema, tenantId, (runner) =>
      TenantScope.#within(runner, tenantId, 'write', fn),
    );
  }

  static async #within<T>(
    runner: QueryRunner,
    tenantId: string,
    access: TenantScopeAccess,
    fn: (scope: TenantScope) => Promise<T>,
  ): Promise<T> {
    const scope = new TenantScope(runner, tenantId, access);
    try {
      return await fn(scope);
    } finally {
      scope.#open = false;
    }
  }

  #assertOpen(): void {
    if (!this.#open) throw new TenantScopeClosedError();
  }
}
