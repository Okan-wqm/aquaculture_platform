/**
 * DERIVED_COST_SOURCES — the single declarative registry mapping farm
 * domain money data onto finance system categories.
 *
 * # Why query-time derivation, not projection rows
 *
 * Feed cost lives on feeding_records, fingerling cost on batches_v2,
 * maintenance cost on work_orders, treatment cost on health_events and
 * harvest revenue on harvest_records. Those rows ARE the source of truth
 * — the finance ledger reads them where they live instead of copying
 * them into finance_expense_entries. A persisted copy would need a sync
 * hook on every create/update/delete of five different aggregates; each
 * missed hook is silent drift (the documented feed_inventory /
 * storage_inventory dual-ledger failure mode). Deriving at query time
 * makes drift structurally impossible, and editing the source record
 * (e.g. correcting a feeding's cost in the feeding form) is reflected in
 * the finance tab with no reconciliation step.
 *
 * # Adding a new money-bearing domain
 *
 * Add one entry here + a matching system category in
 * DEFAULT_FARM_FINANCE_CATEGORIES (finance-category-seed.service.ts).
 * The parity invariant spec (finance-derived-source-category-parity)
 * fails CI when the two lists disagree.
 *
 * # SQL fragments
 *
 * The select fragments reference REAL quoted column names of the source
 * tables (unqualified — search_path routes to the tenant schema). They
 * are never interpolated with user input; date-range filtering binds
 * parameters. `requiredColumns` lists every entity property the
 * fragments touch so the parity spec can detect column renames at PR
 * time instead of runtime.
 */
import type { EntityTarget, ObjectLiteral } from 'typeorm';

import { Batch } from '../../batch/entities/batch.entity';
import { FeedingRecord } from '../../feeding/entities/feeding-record.entity';
import { HarvestRecord } from '../../harvest/entities/harvest-record.entity';
import { HealthEvent } from '../../fish-health/entities/health-event.entity';
import { WorkOrder } from '../../maintenance/entities/work-order.entity';
import { FinanceCategoryKind } from '../entities/finance-category.entity';

export interface DerivedCostSource {
  /** Stable system category code the derived rows book under. */
  systemCode: string;
  /** Human label for logs/tests. */
  label: string;
  kind: FinanceCategoryKind;
  /** Domain the line item's edit deep-link points at (frontend routing key). */
  sourceDomain: 'feeding' | 'batch' | 'maintenance' | 'fish-health' | 'harvest';
  entity: EntityTarget<ObjectLiteral>;
  /** Table name (matches the @Entity() declaration). */
  table: string;
  alias: string;
  /** SQL expression producing the monetary amount (numeric). */
  amountExpr: string;
  /** SQL expression producing the booking date (date/timestamp). */
  dateExpr: string;
  /** SQL expression for the row's currency, or null when the table has none. */
  currencyExpr: string | null;
  batchIdExpr: string | null;
  siteIdExpr: string | null;
  /** SQL boolean expression marking rows whose amount is an estimate. */
  estimatedExpr: string;
  /** Static WHERE fragment excluding rows with no bookable amount. */
  baseWhere: string;
  /**
   * Entity property names the expressions above reference — the
   * parity invariant asserts each is a real mapped column so a rename
   * in the source entity fails CI, not production queries.
   */
  requiredColumns: readonly string[];
}

export const DERIVED_COST_SOURCES: readonly DerivedCostSource[] = [
  {
    systemCode: 'FEED',
    label: 'Feed cost (feeding records)',
    kind: FinanceCategoryKind.EXPENSE,
    sourceDomain: 'feeding',
    entity: FeedingRecord,
    table: 'feeding_records',
    alias: 'fr',
    amountExpr: 'fr."feedCost"',
    dateExpr: 'fr."feedingDate"',
    currencyExpr: 'fr."currency"',
    batchIdExpr: 'fr."batchId"',
    siteIdExpr: null,
    estimatedExpr: 'false',
    baseWhere: 'fr."feedCost" IS NOT NULL AND fr."feedCost" > 0',
    requiredColumns: ['feedCost', 'feedingDate', 'currency', 'batchId'],
  },
  {
    systemCode: 'FINGERLINGS',
    label: 'Fingerling purchase cost (batches)',
    kind: FinanceCategoryKind.EXPENSE,
    sourceDomain: 'batch',
    entity: Batch,
    table: 'batches_v2',
    alias: 'b',
    amountExpr: 'b."purchaseCost"',
    dateExpr: 'b."stockedAt"',
    currencyExpr: 'b."currency"',
    batchIdExpr: 'b."id"',
    siteIdExpr: null,
    estimatedExpr: 'false',
    baseWhere: 'b."purchaseCost" IS NOT NULL AND b."purchaseCost" > 0',
    requiredColumns: ['purchaseCost', 'stockedAt', 'currency', 'id'],
  },
  {
    systemCode: 'MAINTENANCE',
    label: 'Maintenance cost (work orders)',
    kind: FinanceCategoryKind.EXPENSE,
    sourceDomain: 'maintenance',
    entity: WorkOrder,
    table: 'work_orders',
    alias: 'wo',
    // Real cost summary once the work order is costed; the estimate until then.
    amountExpr:
      `COALESCE((wo."costSummary"->>'totalCost')::numeric, wo."estimatedCost")`,
    dateExpr: 'COALESCE(wo."completedAt", wo."createdAt")',
    currencyExpr: 'wo."currency"',
    batchIdExpr: null,
    siteIdExpr: null,
    estimatedExpr: `(wo."costSummary"->>'totalCost') IS NULL`,
    baseWhere:
      `COALESCE((wo."costSummary"->>'totalCost')::numeric, wo."estimatedCost") IS NOT NULL` +
      ` AND COALESCE((wo."costSummary"->>'totalCost')::numeric, wo."estimatedCost") > 0` +
      ` AND wo."status" != 'CANCELLED'`,
    requiredColumns: ['costSummary', 'estimatedCost', 'completedAt', 'createdAt', 'currency', 'status'],
  },
  {
    systemCode: 'HEALTH_TREATMENT',
    label: 'Treatment cost (health events)',
    kind: FinanceCategoryKind.EXPENSE,
    sourceDomain: 'fish-health',
    entity: HealthEvent,
    table: 'health_events',
    alias: 'he',
    amountExpr: 'he."estimatedCost"',
    dateExpr: 'he."eventDate"',
    currencyExpr: null,
    batchIdExpr: 'he."batchId"',
    siteIdExpr: null,
    estimatedExpr: 'true',
    baseWhere: 'he."estimatedCost" IS NOT NULL AND he."estimatedCost" > 0',
    requiredColumns: ['estimatedCost', 'eventDate', 'batchId'],
  },
  {
    systemCode: 'HARVEST_REVENUE',
    label: 'Harvest revenue (harvest records)',
    kind: FinanceCategoryKind.REVENUE,
    sourceDomain: 'harvest',
    entity: HarvestRecord,
    table: 'harvest_records',
    alias: 'hr',
    amountExpr: 'hr."totalRevenue"',
    dateExpr: 'hr."harvestDate"',
    currencyExpr: 'hr."currency"',
    batchIdExpr: 'hr."batchId"',
    siteIdExpr: null,
    estimatedExpr: 'false',
    baseWhere: 'hr."totalRevenue" IS NOT NULL AND hr."totalRevenue" > 0',
    requiredColumns: ['totalRevenue', 'harvestDate', 'currency', 'batchId'],
  },
  {
    systemCode: 'HARVEST_COST',
    label: 'Harvest operation cost (harvest records)',
    kind: FinanceCategoryKind.EXPENSE,
    sourceDomain: 'harvest',
    entity: HarvestRecord,
    table: 'harvest_records',
    alias: 'hc',
    amountExpr: 'hc."harvestCost"',
    dateExpr: 'hc."harvestDate"',
    currencyExpr: 'hc."currency"',
    batchIdExpr: 'hc."batchId"',
    siteIdExpr: null,
    estimatedExpr: 'false',
    baseWhere: 'hc."harvestCost" IS NOT NULL AND hc."harvestCost" > 0',
    requiredColumns: ['harvestCost', 'harvestDate', 'currency', 'batchId'],
  },
] as const;

/** System codes bound to derived sources — these categories cannot be archived. */
export const DERIVED_SYSTEM_CODES: ReadonlySet<string> = new Set(
  DERIVED_COST_SOURCES.map((s) => s.systemCode),
);
