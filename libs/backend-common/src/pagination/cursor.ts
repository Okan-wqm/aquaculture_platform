/**
 * Cursor Pagination Primitive
 *
 * Opaque-cursor pagination (Relay-style forward traversal) for
 * platform-wide adoption across list resolvers. Replaces the
 * offset/limit pattern for hot paths where:
 *
 *   - Tables grow past 10k rows and `LIMIT n OFFSET m` walks
 *     every intervening row under the hood (O(n+m) cost on
 *     PostgreSQL).
 *   - New rows insert mid-traversal and shift offsets mid-list
 *     (classic offset-skip / offset-duplicate race).
 *
 * Phase 5.1 of the "Farm modülü kalan kör noktalar" plan. This
 * commit lands the primitive. Resolver migration is a parallel
 * API (existing `PaginationInput` stays in place for the
 * deprecation window); each list resolver opts in by swapping
 * `first / after` args for the legacy `page / limit` shape when
 * its callers are ready.
 *
 * # Cursor shape
 *
 * An opaque string that encodes `{ id, createdAt }` as
 * Base64url-JSON. The caller treats it as an opaque token —
 * never parses, never compares. Changes to the encoded shape
 * stay additive (new fields ignored on decode) so future
 * versions don't force a client-side cache invalidation.
 *
 *   encode(row): "eyJpZCI6IjEyMyIsImNyZWF0ZWRBdCI6IjIwMjYtMDQtMjNUMTI6MDA6MDBaIn0"
 *   decode(cursor): { id: '123', createdAt: Date('2026-04-23T12:00:00Z') }
 *
 * # Safety invariants
 *
 *   1. **Parseable or 400.** A malformed cursor raises a
 *      `BadRequestException` the resolver layer surfaces as a
 *      GraphQL error — never a silent fallback to page 1
 *      (which would bury the bug under unexpected pagination).
 *   2. **first is bounded.** Caller passes `first` up to a
 *      per-resolver cap (typically 100); values above the cap
 *      raise a BadRequestException. Prevents a malicious or
 *      buggy client requesting 10M rows in one shot.
 *   3. **No ORDER BY in the encoder.** Callers must ORDER BY
 *      `(createdAt DESC, id DESC)` on the DB side. The cursor
 *      only encodes the tie-breaker pair; it is not a
 *      universal sort spec.
 *
 * # Query predicate
 *
 * Given a decoded cursor `{ id, createdAt }`, the next page's
 * WHERE predicate is:
 *
 *   (createdAt, id) < (cursor.createdAt, cursor.id)
 *
 * on tables ordered `ORDER BY createdAt DESC, id DESC`. The
 * compound tuple comparison eliminates ties deterministically
 * without requiring a UUID natural sort.
 *
 * Module: @aquaculture/backend-common/pagination
 */
import { BadRequestException, type Type } from '@nestjs/common';
import { Field, Int, InputType, ObjectType } from '@nestjs/graphql';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

/** Default upper bound on `first` when a resolver doesn't override. */
export const DEFAULT_FIRST_CAP = 100;

/** Default `first` when the caller omits it. */
export const DEFAULT_FIRST = 20;

/**
 * The payload that gets Base64url-encoded. `id` + `createdAt`
 * together form a deterministic tuple cursor that survives tied
 * timestamps without requiring UUID natural sort.
 */
export interface CursorPayload {
  id: string;
  createdAt: Date;
}

/**
 * A row that can be encoded into a cursor. Keeps the primitive
 * agnostic of the full entity shape — the only fields needed
 * for cursor generation are the two tie-breaker columns.
 */
export interface CursorKeyedRow {
  id: string;
  createdAt: Date | string;
}

/** GraphQL input type for forward cursor pagination. */
@InputType({ isAbstract: true })
export class CursorPaginationInput {
  @Field(() => Int, {
    nullable: true,
    defaultValue: DEFAULT_FIRST,
    description: 'Number of items to return (default: 20). Resolver MAY cap at 100.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(DEFAULT_FIRST_CAP)
  first?: number;

  @Field({
    nullable: true,
    description: 'Opaque cursor returned from a previous page. Pass null/omit for the first page.',
  })
  @IsOptional()
  @IsString()
  after?: string;
}

/**
 * Structural shape of a Relay-style cursor edge — the runtime
 * contract `buildCursorResponse()` returns and helper-types
 * downstream consumers refer to. Not a GraphQL type; the GraphQL
 * emission lives in the `CursorEdge(classRef)` factory below.
 *
 * WHY both an interface AND a factory:
 * NestJS GraphQL (code-first) reflects field types at runtime via
 * `reflectTypeFromMetadata`. For a generic class, the type-parameter
 * `T` erases to `undefined` at runtime — TypeScript decorators emit
 * the design-time type, not the resolved one. The previous
 * `CursorEdge<T>` exported a single concrete @ObjectType class with
 * `@Field() node!: T` (no explicit type resolver), so the schema
 * builder saw `undefined` for the node type and threw at bootstrap
 * the moment any module registered a sub-class of it. Closes
 * ORPHAN-CRITICAL-064.
 */
export interface ICursorEdge<T> {
  cursor: string;
  node: T;
}

/**
 * Per-edge wrapper FACTORY — the Relay-style envelope that carries
 * the cursor alongside the node. NestJS-GraphQL idiom for generic
 * @ObjectType classes (https://docs.nestjs.com/graphql/resolvers#generics).
 *
 * Concrete edges extend the returned abstract class:
 *
 * ```typescript
 * @ObjectType()
 * export class EmployeeEdge extends CursorEdge(Employee) {}
 * ```
 *
 * The factory passes `classRef` to `@Field(() => classRef)` explicitly,
 * so the schema builder sees the exact runtime type instead of the
 * erased generic parameter.
 */
export function CursorEdge<T>(classRef: Type<T>): Type<ICursorEdge<T>> {
  @ObjectType({ isAbstract: true })
  abstract class CursorEdgeHost {
    @Field()
    cursor!: string;

    @Field(() => classRef)
    node!: T;
  }
  return CursorEdgeHost as unknown as Type<ICursorEdge<T>>;
}

/** Page info summary — Relay-style, `endCursor` / `hasNextPage` are the ones callers actually use. */
@ObjectType({ isAbstract: true })
export class CursorPageInfo {
  @Field(() => String, {
    nullable: true,
    description: 'Cursor of the final edge in this page. null only when the page has no edges.',
  })
  endCursor!: string | null;

  @Field()
  hasNextPage!: boolean;
}

/**
 * Cursor-paginated response shape. A resolver returns this when
 * the client passes `first / after` instead of the legacy
 * `page / limit`.
 *
 * Generic over the node type — each resolver is expected to
 * declare a concrete subclass with `@ObjectType(...)` that
 * resolves the type parameter. See `buildCursorResponseType()`
 * below for a helper that eliminates the boilerplate.
 */
export interface CursorPaginatedResponse<T> {
  edges: Array<{ cursor: string; node: T }>;
  pageInfo: {
    endCursor: string | null;
    hasNextPage: boolean;
  };
}

/**
 * Encode a cursor-keyed row into an opaque Base64url string.
 * Never call this on caller input — only on rows the resolver
 * is about to return.
 */
export function encodeCursor(row: CursorKeyedRow): string {
  const payload: CursorPayload = {
    id: row.id,
    createdAt: row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt),
  };
  const json = JSON.stringify({
    id: payload.id,
    createdAt: payload.createdAt.toISOString(),
  });
  return Buffer.from(json, 'utf8').toString('base64url');
}

/**
 * Decode an opaque cursor back into the `{ id, createdAt }`
 * tuple a resolver uses to build its WHERE predicate. Throws
 * BadRequestException (HTTP 400) on ANY malformed input —
 * parseable or reject, never silent-fallback.
 */
export function decodeCursor(cursor: string): CursorPayload {
  if (!cursor || typeof cursor !== 'string') {
    throw new BadRequestException(
      'Cursor is empty or not a string. Pass a cursor returned from a previous page, or omit `after` for the first page.',
    );
  }
  let json: string;
  try {
    json = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch (err) {
    throw new BadRequestException(
      `Cursor is not valid base64url: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new BadRequestException(
      `Cursor payload is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    typeof (parsed as { id?: unknown }).id !== 'string' ||
    typeof (parsed as { createdAt?: unknown }).createdAt !== 'string'
  ) {
    throw new BadRequestException(
      'Cursor payload missing required id / createdAt fields. Cursors encode `{ id, createdAt }`.',
    );
  }
  const { id, createdAt } = parsed as { id: string; createdAt: string };
  const createdAtDate = new Date(createdAt);
  if (Number.isNaN(createdAtDate.getTime())) {
    throw new BadRequestException(`Cursor createdAt is not a valid ISO timestamp: '${createdAt}'`);
  }
  return { id, createdAt: createdAtDate };
}

/**
 * Turn a row list + the caller's `first` request into the
 * canonical cursor-paginated response. The resolver fetches
 * `first + 1` rows — if the extra row is present, `hasNextPage`
 * is true and the extra row is dropped before returning.
 *
 *   const raw = await repo.find({ ..., take: first + 1 });
 *   return buildCursorResponse(raw, first);
 *
 * This is the ONLY place a resolver has to think about cursor
 * shape — everything else is the `CursorPaginationInput`
 * contract on the way in.
 */
export function buildCursorResponse<T extends CursorKeyedRow>(
  rows: T[],
  first: number,
): CursorPaginatedResponse<T> {
  const hasNextPage = rows.length > first;
  const nodes = hasNextPage ? rows.slice(0, first) : rows;
  const edges = nodes.map((node) => ({
    cursor: encodeCursor(node),
    node,
  }));
  const endCursor = edges.length > 0 ? edges[edges.length - 1]!.cursor : null;
  return {
    edges,
    pageInfo: { endCursor, hasNextPage },
  };
}

/**
 * Normalise caller input — clamp `first` to [1, cap] and decode
 * `after` if present. Resolvers call this at the top of their
 * query body so the rest of the method can treat the result as
 * trustworthy.
 *
 *   const { first, after } = normaliseCursorInput(input);
 *
 * Passing a resolver-specific `firstCap` tightens the default;
 * a list that's genuinely heavy per row (analytics rollups,
 * document lists with file metadata) might cap at 50 instead of 100.
 */
export function normaliseCursorInput(
  input: CursorPaginationInput | null | undefined,
  firstCap: number = DEFAULT_FIRST_CAP,
): { first: number; after: CursorPayload | null } {
  const rawFirst = input?.first ?? DEFAULT_FIRST;
  if (!Number.isInteger(rawFirst) || rawFirst < 1) {
    throw new BadRequestException(
      `Cursor pagination 'first' must be a positive integer (got ${rawFirst}).`,
    );
  }
  if (rawFirst > firstCap) {
    throw new BadRequestException(
      `Cursor pagination 'first' (${rawFirst}) exceeds the per-resolver cap of ${firstCap}. ` +
        'Lower the request or page through the list.',
    );
  }
  const after = input?.after ? decodeCursor(input.after) : null;
  return { first: rawFirst, after };
}
