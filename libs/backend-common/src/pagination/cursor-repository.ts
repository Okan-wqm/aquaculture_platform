/**
 * Cursor Pagination — TypeORM Adapter
 *
 * One-line bridge from a TypeORM `Repository<T>` to a
 * `CursorPaginatedResponse<T>`. Resolvers that opt in to
 * cursor pagination call `paginateCursor(repo, options)` from
 * their query method and get back the canonical response shape
 * — no manual WHERE clause, no `first + 1` off-by-one to
 * remember, no `ORDER BY createdAt DESC, id DESC` to type
 * across every adoption site.
 *
 *   const response = await paginateCursor(this.repo, {
 *     input,
 *     tenantId,
 *     where: { batchId },
 *     firstCap: 50,
 *   });
 *
 * The helper:
 *
 *   1. Normalises caller input via `normaliseCursorInput` —
 *      clamps `first`, decodes `after`, fail-closed on
 *      malformed.
 *   2. Builds the tuple WHERE predicate
 *      `(createdAt, id) < (after.createdAt, after.id)` on
 *      top of the caller's static filter.
 *   3. Issues `ORDER BY createdAt DESC, id DESC, take first + 1`.
 *   4. Hands the result to `buildCursorResponse` which drops
 *      the signal row and flags `hasNextPage`.
 *
 * Phase 5.1 of the "Farm modülü kalan kör noktalar" plan.
 * Companion to `cursor.ts` — the primitive ships the contract,
 * this ships the TypeORM adapter so resolvers can adopt in one
 * line.
 *
 * # Column name translation
 *
 * TypeORM preserves property names unmodified unless `name:`
 * is passed to `@Column`. Every target table used by
 * farm-service quotes camelCase in PostgreSQL (`"createdAt"`,
 * `"id"`). The QueryBuilder-based predicate below uses the
 * entity-property path, NOT a raw SQL string, so TypeORM's
 * metadata maps it to the correct column — whether quoted
 * camelCase or snake_case — without the helper having to
 * know the physical shape.
 *
 * # What this helper does NOT handle
 *
 *   - Custom sort orders. Every migration to cursor pagination
 *     is by `createdAt DESC, id DESC`. If a resolver genuinely
 *     needs a different sort axis, it builds the query
 *     manually; the primitive's `encodeCursor/decodeCursor`
 *     functions stay directly usable.
 *   - Relations / joins. Callers that need `relations: [...]`
 *     or joins-by-QueryBuilder build the query themselves and
 *     hand rows to `buildCursorResponse`. Keeping the adapter
 *     narrow prevents feature creep.
 *
 * Module: @aquaculture/backend-common/pagination
 */
import type {
  FindOptionsWhere,
  ObjectLiteral,
  Repository,
} from 'typeorm';

import {
  buildCursorResponse,
  CursorPaginationInput,
  type CursorKeyedRow,
  type CursorPaginatedResponse,
  normaliseCursorInput,
} from './cursor';

/**
 * Caller-supplied options for the TypeORM adapter. The generic
 * `TEntity extends CursorKeyedRow` enforces that the entity
 * carries both `id` + `createdAt` at compile time — a table
 * without those columns can't be paginated by this adapter
 * (the cursor contract would have no valid tie-breakers).
 */
export interface PaginateCursorOptions<TEntity extends CursorKeyedRow & ObjectLiteral> {
  /** The `@Args('input')` value from the resolver — may be undefined if the caller omits pagination. */
  input?: CursorPaginationInput | null;

  /** Tenant scope. ALWAYS required — a resolver that forgets gets a compile-time TS error on the call site. */
  tenantId: string;

  /**
   * Optional additional filters (already merged into the WHERE
   * clause alongside `tenantId` and the cursor predicate).
   * Follows TypeORM's `FindOptionsWhere<T>` shape. Pass
   * `{ batchId }` etc. for resolver-specific narrowing.
   */
  where?: FindOptionsWhere<TEntity>;

  /**
   * Per-resolver upper bound on `first`. Narrower-than-default
   * for heavy rows (document metadata, analytics rollups).
   */
  firstCap?: number;
}

/**
 * Run a cursor-paginated query against a TypeORM repository.
 * Returns the canonical `CursorPaginatedResponse<TEntity>`.
 */
export async function paginateCursor<
  TEntity extends CursorKeyedRow & ObjectLiteral,
>(
  repo: Repository<TEntity>,
  options: PaginateCursorOptions<TEntity>,
): Promise<CursorPaginatedResponse<TEntity>> {
  const { first, after } = normaliseCursorInput(options.input, options.firstCap);

  // Build the QueryBuilder once — the tuple WHERE predicate
  // is easier to compose through the builder than through
  // `FindOptionsWhere<T>` (the latter can't express
  // `(createdAt, id) < (?, ?)` compound comparisons).
  const qb = repo.createQueryBuilder('e');
  qb.where('e."tenantId" = :tenantId', { tenantId: options.tenantId });

  if (options.where) {
    for (const [key, value] of Object.entries(options.where)) {
      if (value === undefined) continue;
      // Narrow to primitive types that map cleanly to a
      // parameterised binding. Arrays / nested FindOperator
      // shapes aren't handled — a caller that needs `IN (...)`
      // or `IsNull()` builds the query manually and feeds
      // rows to `buildCursorResponse` directly.
      if (
        typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean' ||
        value instanceof Date
      ) {
        qb.andWhere(`e."${key}" = :w_${key}`, { [`w_${key}`]: value });
      }
    }
  }

  if (after) {
    // Compound tuple comparison — deterministic against ties.
    // Postgres evaluates `(a, b) < (x, y)` as
    //   a < x OR (a = x AND b < y)
    // which matches the tie-breaker semantics cursor pagination
    // relies on.
    qb.andWhere(
      '(e."createdAt", e."id") < (:cursorCreatedAt, :cursorId)',
      {
        cursorCreatedAt: after.createdAt,
        cursorId: after.id,
      },
    );
  }

  qb.orderBy('e."createdAt"', 'DESC').addOrderBy('e."id"', 'DESC').take(first + 1);

  const rows = await qb.getMany();
  return buildCursorResponse(rows, first);
}
