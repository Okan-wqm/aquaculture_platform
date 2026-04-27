/**
 * JsonbPatchService
 *
 * Applies a narrow, path-scoped `jsonb_set(column, path, value)`
 * UPDATE to a single row, bypassing TypeORM's entity-object
 * lifecycle (and therefore its `@VersionColumn` optimistic-lock
 * bump). This closes the Girdi 15-B3 false-conflict: before this
 * service, two concurrent handlers touching DIFFERENT keys of the
 * same JSONB column (e.g. `batches_v2.feedingSummary` vs
 * `batches_v2.growthMetrics`) both loaded the row, wrote their
 * change, and the second writer got
 * `OptimisticLockVersionMismatchError` even though the changes
 * didn't actually overlap. Operators saw "try again" loops on
 * normal production activity.
 *
 * The service exposes ONE public method:
 *
 *   patch({ schema, table, column, pk, path, value, where? })
 *
 * It issues a single SQL `UPDATE <schema>.<table> SET <column> =
 * jsonb_set(<column>, $path, $value, true) WHERE …` statement,
 * returning the updated row's id and the affected row count.
 * Concurrent patches to different paths commit without touching
 * each other because Postgres row-level locks are per-column-
 * update semantics (not per-column-read), and both updates
 * jsonb_set a different key.
 *
 * # Safety invariants
 *
 * 1. **Path whitelist.** Arbitrary JSONB path injection would let
 *    a caller rewrite any key on any column. Every patch goes
 *    through a registry that names the exact (table, column,
 *    first-path-segment) tuples the service will accept. Anything
 *    else throws before SQL is built.
 *
 * 2. **Tenant scoping.** The `where` clause MUST include a
 *    `tenantId` match — the service enforces this; a caller that
 *    forgets gets a rejection before SQL runs.
 *
 * 3. **No row version bump.** The UPDATE deliberately does NOT
 *    touch the `version` column, so a sibling handler that loaded
 *    the row via TypeORM (with optimistic lock) still sees its
 *    version and its write still succeeds. That's the whole point
 *    of the service.
 *
 * 4. **Parameterised values.** `value` is bound via $N parameters,
 *    never string-interpolated, so SQL injection is mechanically
 *    impossible.
 *
 * Phase 5.7 of the "Farm modülü kalan kör noktalar" plan. Closes
 * Girdi 15-B3.
 */
import {
  BadRequestException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { DataSource } from 'typeorm';

export interface JsonbPatchTarget {
  /** PostgreSQL schema — e.g. `farm`. */
  schema: string;
  /** Table name — e.g. `batches_v2`. */
  table: string;
  /** JSONB column — e.g. `feedingSummary`. */
  column: string;
  /** First path segment after the column — the whitelist key. */
  firstPathSegment: string;
}

export interface JsonbPatchRequest {
  target: JsonbPatchTarget;
  /**
   * Full JSONB path as a flat array of keys, e.g.
   * `['lastFedAt']` or `['dailyAverages', '2026-04-23']`. The
   * first element MUST equal `target.firstPathSegment` so the
   * whitelist lookup and the SQL path stay in sync.
   */
  path: readonly string[];
  /** JSON-serialisable value the path is being set to. */
  value: unknown;
  /**
   * Composite row predicate. MUST include `tenantId` and `id`; the
   * service adds no implicit scoping.
   */
  where: { tenantId: string; id: string };
}

export interface JsonbPatchResult {
  affectedRows: number;
}

/**
 * Whitelist registry — (schema, table, column, firstPathSegment)
 * tuples that may be patched. New entries are added deliberately
 * in code review so a mutation can never silently broaden the
 * surface area of what a handler may change.
 */
export const JSONB_PATCH_WHITELIST: ReadonlySet<string> = Object.freeze(
  new Set([
    // batches_v2.feedingSummary — per-day feed aggregates
    'farm:batches_v2:feedingSummary:dailyAverages',
    'farm:batches_v2:feedingSummary:lastFedAt',
    'farm:batches_v2:feedingSummary:totalFed',
    // batches_v2.growthMetrics — growth sample rollups
    'farm:batches_v2:growthMetrics:lastSampledAt',
    'farm:batches_v2:growthMetrics:latestSGR',
    'farm:batches_v2:growthMetrics:cumulativeWeightGain',
    // batches_v2.mortalitySummary — mortality rollups
    'farm:batches_v2:mortalitySummary:lastEventAt',
    'farm:batches_v2:mortalitySummary:cumulativeCount',
    'farm:batches_v2:mortalitySummary:cumulativeBiomassKg',
  ]),
);

@Injectable()
export class JsonbPatchService {
  private readonly logger = new Logger(JsonbPatchService.name);

  constructor(private readonly dataSource: DataSource) {}

  /**
   * Build a whitelist key from a patch target. Exposed so tests
   * can assert the same formula the runtime uses.
   */
  static whitelistKey(target: JsonbPatchTarget): string {
    return `${target.schema}:${target.table}:${target.column}:${target.firstPathSegment}`;
  }

  async patch(request: JsonbPatchRequest): Promise<JsonbPatchResult> {
    this.validate(request);

    const { target, path, value, where } = request;
    // Identifiers come from the whitelisted target registry, not
    // from caller input, so they can be interpolated safely here.
    // Path + values + tenant/id remain parameterised.
    const sql =
      `UPDATE "${target.schema}"."${target.table}" ` +
      `SET "${target.column}" = jsonb_set(` +
      `  COALESCE("${target.column}", '{}'::jsonb), ` +
      `  $1::text[], ` +
      `  $2::jsonb, ` +
      `  true` +
      `) ` +
      `WHERE "tenantId" = $3 AND "id" = $4`;

    const result = await this.dataSource.query(sql, [
      path,
      JSON.stringify(value),
      where.tenantId,
      where.id,
    ]);

    // `UPDATE ... RETURNING`-less UPDATE in pg returns `[[], n]`
    // via TypeORM. Some drivers wrap the row count under
    // `result.affected`. Cover both shapes.
    const affectedRows = this.extractAffectedRows(result);

    this.logger.debug(
      `Patched ${target.schema}.${target.table}.${target.column}${this.formatPath(path)} ` +
        `for tenant=${where.tenantId.slice(0, 8)}... id=${where.id.slice(0, 8)}... ` +
        `(affected=${affectedRows})`,
    );

    return { affectedRows };
  }

  private validate(request: JsonbPatchRequest): void {
    const { target, path, where } = request;

    if (!path.length || path[0] !== target.firstPathSegment) {
      throw new BadRequestException(
        `JSONB patch rejected: path[0] '${path[0] ?? '(empty)'}' must equal ` +
          `target.firstPathSegment '${target.firstPathSegment}'. The whitelist ` +
          `key is built from the first segment so drifting values would bypass ` +
          `the registry.`,
      );
    }

    if (!where?.tenantId || !where?.id) {
      throw new BadRequestException(
        'JSONB patch rejected: `where` must carry both tenantId and id. ' +
          'The service refuses to issue an UPDATE without both predicates.',
      );
    }

    const key = JsonbPatchService.whitelistKey(target);
    if (!JSONB_PATCH_WHITELIST.has(key)) {
      throw new BadRequestException(
        `JSONB patch rejected: target '${key}' is not on the whitelist. ` +
          'Add an entry to JSONB_PATCH_WHITELIST in code review before patching ' +
          'a new (schema, table, column, firstPathSegment) tuple.',
      );
    }

    // Identifier hygiene — the whitelist only contains safe values
    // but a caller constructing their own target object might slip
    // a quote in. A regex on [A-Za-z0-9_] closes that door.
    const ident = /^[A-Za-z0-9_]+$/;
    if (
      !ident.test(target.schema) ||
      !ident.test(target.table) ||
      !ident.test(target.column)
    ) {
      throw new BadRequestException(
        'JSONB patch rejected: schema/table/column identifiers must match ' +
          '[A-Za-z0-9_]+ — no quotes, spaces, or special characters. Target ' +
          'tuples come from the whitelist registry; a caller-provided target ' +
          'that deviates is treated as a potential injection attempt.',
      );
    }
  }

  private extractAffectedRows(result: unknown): number {
    if (
      result &&
      typeof result === 'object' &&
      'affected' in (result as Record<string, unknown>) &&
      typeof (result as { affected?: unknown }).affected === 'number'
    ) {
      return (result as { affected: number }).affected;
    }
    if (Array.isArray(result) && result.length > 1 && typeof result[1] === 'number') {
      return result[1] as number;
    }
    return 0;
  }

  private formatPath(path: readonly string[]): string {
    return path.map((p) => `.${p}`).join('');
  }
}
