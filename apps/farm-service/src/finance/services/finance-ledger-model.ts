/**
 * Finance ledger read model — the shapes, the granularity rules and the pure
 * UNION-aggregation builders shared by the tenant-scoped ledger reader
 * (finance-ledger-reader.ts) and the line-item query service
 * (finance-ledger-query.service.ts).
 *
 * WHY a module of its own: the AI finance subjects reach the reader, which
 * may read only through a TenantScope (K10 layer 4). Keeping the pure builders
 * apart from the service that holds a DataSource keeps that reachable code
 * free of any connection of its own.
 */
import Decimal from 'decimal.js';

import { FinanceCategoryKind, FinanceCategoryScope } from '../entities/finance-category.entity';

export enum FinanceGranularity {
  DAY = 'DAY',
  WEEK = 'WEEK',
  MONTH = 'MONTH',
  YEAR = 'YEAR',
}

/** Enum → date_trunc literal. The ONLY path from API input to SQL. */
export const GRANULARITY_SQL: Record<FinanceGranularity, string> = {
  [FinanceGranularity.DAY]: 'day',
  [FinanceGranularity.WEEK]: 'week',
  [FinanceGranularity.MONTH]: 'month',
  [FinanceGranularity.YEAR]: 'year',
};

/** Coarsest-to-finest order + approximate days/bucket, for bucket bounding. */
const GRANULARITY_DAYS: Array<[FinanceGranularity, number]> = [
  [FinanceGranularity.DAY, 1],
  [FinanceGranularity.WEEK, 7],
  [FinanceGranularity.MONTH, 30],
  [FinanceGranularity.YEAR, 365],
];

/**
 * Upper bound on time-series buckets. A DAY granularity over multiple years
 * would emit ~1000+ buckets, each triggering a computed-rule pass and bloating
 * the payload. Beyond this the granularity is auto-coarsened to the next step.
 */
const MAX_SERIES_BUCKETS = 400;

/** Top-N per-batch rows returned; the remainder is rolled into an "Other" row. */
export const MAX_BATCH_ROWS = 25;
/** Synthetic batchId for the aggregated tail in the per-batch chart. */
export const OTHER_BATCH_ID = 'other';

/**
 * Auto-coarsen the requested granularity so the series can never exceed
 * MAX_SERIES_BUCKETS — bounded server work and payload regardless of range.
 */
export const clampGranularity = (
  range: { from: Date; to: Date },
  requested: FinanceGranularity,
): FinanceGranularity => {
  const spanDays = Math.max(1, (range.to.getTime() - range.from.getTime()) / 86_400_000);
  let chosen = requested;
  for (const [gran, days] of GRANULARITY_DAYS) {
    if (days < (GRANULARITY_DAYS.find(([g]) => g === requested)?.[1] ?? 1)) continue;
    if (spanDays / days <= MAX_SERIES_BUCKETS) {
      chosen = gran;
      break;
    }
    chosen = gran;
  }
  return chosen;
};

export enum FinanceLineOrigin {
  MANUAL = 'MANUAL',
  DERIVED = 'DERIVED',
}

export interface FinanceLineItemShape {
  id: string;
  origin: FinanceLineOrigin;
  categoryId: string | null;
  categoryCode: string | null;
  categoryName: string;
  kind: FinanceCategoryKind;
  amount: number;
  currency: string;
  entryDate: Date;
  batchId: string | null;
  siteId: string | null;
  description: string | null;
  estimated: boolean;
  /** MANUAL rows are editable in the finance tab; DERIVED rows deep-link to their source. */
  editable: boolean;
  sourceDomain: string | null;
  sourceRecordId: string | null;
}

export interface LedgerFilter {
  from?: Date;
  to?: Date;
  scope?: FinanceCategoryScope;
  categoryId?: string;
  batchId?: string;
  siteId?: string;
  includeDerived: boolean;
  limit: number;
  offset: number;
}

export interface CategoryTotalShape {
  categoryId: string;
  categoryCode: string | null;
  categoryName: string;
  scope: FinanceCategoryScope;
  kind: FinanceCategoryKind;
  isComputed: boolean;
  isDerived: boolean;
  total: number;
}

export interface TimeBucketShape {
  bucketStart: Date;
  totalExpense: number;
  totalRevenue: number;
}

export interface BatchTotalShape {
  batchId: string;
  totalExpense: number;
  totalRevenue: number;
}

export interface FinanceSummaryShape {
  currency: string;
  totalExpense: number;
  totalRevenue: number;
  netResult: number;
  byCategory: CategoryTotalShape[];
  series: TimeBucketShape[];
}

/** Whitelisted `date_trunc` units — the ONLY strings ever interpolated into SQL. */
const VALID_TRUNC_UNITS: ReadonlySet<string> = new Set(Object.values(GRANULARITY_SQL));

/** One derived-cost source resolved to its table + system category for a UNION branch. */
export interface DerivedBranchSpec {
  /** Real (metadata) table name; search_path routes it to the tenant schema. */
  table: string;
  alias: string;
  amountExpr: string;
  dateExpr: string;
  baseWhere: string;
  /** Resolved system-category id this source books under (bound, never interpolated). */
  categoryId: string;
  /** batch dimension expression — required for the per-batch aggregation. */
  batchIdExpr: string | null;
}

/** A grouped aggregation row from the single-UNION query (keys match the SELECT aliases). */
export interface UnionAggRow {
  bucket: string | null;
  batch_id: string | null;
  category_id: string;
  total: string;
}

/**
 * Build the finance *summary* aggregation as ONE `UNION ALL` query instead of
 * 1 manual + N derived round-trips (PERF-009). Manual entries and every derived
 * source project the same `(bucket, category_id, total)` shape and are summed in
 * a single DB round-trip. Positional params are shared: `$1`=tenantId, `$2`=from,
 * `$3`=to across all branches; each derived branch appends its resolved category
 * id (bound, never interpolated). Column/date/amount fragments come only from the
 * developer-authored DERIVED_COST_SOURCES registry, and `truncUnit` is asserted
 * against the enum whitelist — so no API input ever reaches the SQL string.
 */
export function buildSummaryAggregationQuery(
  tenantId: string,
  from: Date,
  to: Date,
  truncUnit: string,
  derived: readonly DerivedBranchSpec[],
): { sql: string; params: unknown[] } {
  if (!VALID_TRUNC_UNITS.has(truncUnit)) {
    throw new Error(`Illegal date_trunc unit: ${truncUnit}`);
  }
  const params: unknown[] = [tenantId, from, to];
  const branches: string[] = [
    `SELECT to_char(date_trunc('${truncUnit}', e."entryDate"), 'YYYY-MM-DD') AS bucket, ` +
      `NULL::text AS batch_id, e."categoryId"::text AS category_id, SUM(e."amount") AS total ` +
      `FROM finance_expense_entries e ` +
      `WHERE e."tenantId" = $1 AND e."isDeleted" = false ` +
      `AND e."entryDate" >= $2 AND e."entryDate" <= $3 ` +
      `GROUP BY bucket, e."categoryId"`,
  ];
  for (const d of derived) {
    params.push(d.categoryId);
    const catRef = `$${params.length}`;
    branches.push(
      `SELECT to_char(date_trunc('${truncUnit}', ${d.dateExpr} AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS bucket, ` +
        `NULL::text AS batch_id, ${catRef}::text AS category_id, SUM(${d.amountExpr}) AS total ` +
        `FROM ${d.table} ${d.alias} ` +
        `WHERE ${d.baseWhere} AND ${d.alias}."tenantId" = $1 ` +
        `AND ${d.dateExpr} >= $2 AND ${d.dateExpr} <= $3 ` +
        `GROUP BY bucket`,
    );
  }
  return { sql: branches.join(' UNION ALL '), params };
}

/**
 * Build the per-*batch* aggregation as ONE `UNION ALL` query (PERF-009). Only
 * derived sources that carry a batch dimension contribute; manual entries with a
 * non-null batch are always included. Shared params: `$1`=tenantId, `$2`=from,
 * `$3`=to; each derived branch appends its resolved category id.
 */
export function buildBatchAggregationQuery(
  tenantId: string,
  from: Date,
  to: Date,
  derived: readonly DerivedBranchSpec[],
): { sql: string; params: unknown[] } {
  const params: unknown[] = [tenantId, from, to];
  const branches: string[] = [
    `SELECT NULL::text AS bucket, e."batchId"::text AS batch_id, ` +
      `e."categoryId"::text AS category_id, SUM(e."amount") AS total ` +
      `FROM finance_expense_entries e ` +
      `WHERE e."tenantId" = $1 AND e."isDeleted" = false AND e."batchId" IS NOT NULL ` +
      `AND e."entryDate" >= $2 AND e."entryDate" <= $3 ` +
      `GROUP BY e."batchId", e."categoryId"`,
  ];
  for (const d of derived) {
    if (!d.batchIdExpr) continue;
    params.push(d.categoryId);
    const catRef = `$${params.length}`;
    branches.push(
      `SELECT NULL::text AS bucket, ${d.batchIdExpr}::text AS batch_id, ` +
        `${catRef}::text AS category_id, SUM(${d.amountExpr}) AS total ` +
        `FROM ${d.table} ${d.alias} ` +
        `WHERE ${d.baseWhere} AND ${d.alias}."tenantId" = $1 ` +
        `AND ${d.dateExpr} >= $2 AND ${d.dateExpr} <= $3 ` +
        `GROUP BY ${d.batchIdExpr}`,
    );
  }
  return { sql: branches.join(' UNION ALL '), params };
}

/**
 * Money rounding SSoT for the read model: exact 2dp HALF_EVEN via Decimal,
 * converted to a JS number only at the GraphQL boundary. All accumulation
 * upstream is Decimal, so no IEEE-754 float drift enters the totals.
 */
export const toMoney = (value: Decimal): number =>
  value.toDecimalPlaces(2, Decimal.ROUND_HALF_EVEN).toNumber();

/**
 * Exact 2dp rounding of a single source amount (derived line items).
 *
 * Named apart from the shared `round2` deliberately. This rounds through
 * `Decimal` with ROUND_HALF_EVEN because a ledger amount must never be rounded
 * by float arithmetic; the shared helper is float and is correct for kg and
 * temperatures, not money. Carrying the same NAME for two different operations
 * is what invited a consolidation that would have quietly moved currency onto
 * floats.
 */
export const toMoneyAmount = (value: string | number): number => toMoney(new Decimal(value));
