/**
 * How every reader names a water-quality measurement's unit: the tank it is
 * filed under, else its equipment — COALESCE(tankId, equipmentId).
 *
 * The writers file a unit in exactly one column (measurement-unit.ts); rows
 * written before that may carry the same id in both, or a tank only as
 * `equipmentId` (the old batch writer), and the coalesce names the unit of all
 * of them. A reader keyed on `tankId` alone drops every non-tank equipment row
 * (a biofilter, a sump) and every batch-entered tank row, so readers use these
 * helpers and never the bare column (enforced by
 * __tests__/measurement-unit-readers.invariant.spec.ts).
 *
 * Kept free of database imports so any reader, raw-SQL services included, can
 * use it.
 */
import type { WaterQualityMeasurement } from '../entities/water-quality-measurement.entity';

/** The unit a loaded measurement row was taken at: its tank, else its equipment. */
export function measurementUnitIdOf(
  row: Pick<WaterQualityMeasurement, 'tankId' | 'equipmentId'>,
): string | undefined {
  return row.tankId ?? row.equipmentId ?? undefined;
}

function quotedColumn(alias: string, column: 'tankId' | 'equipmentId'): string {
  return `"${alias}"."${column}"`;
}

/**
 * SQL for the unit id of the measurement aliased `alias`. The columns are
 * quoted, so the same text is valid in a TypeORM query builder and in raw SQL.
 */
export function measurementUnitIdSql(alias: string): string {
  return `COALESCE(${quotedColumn(alias, 'tankId')}, ${quotedColumn(alias, 'equipmentId')})`;
}

/**
 * A predicate on the unit of the measurement aliased `alias`; `comparison` is
 * the right-hand side (`= :unitId`, `IN (:...unitIds)`, `= ANY($1)`).
 *
 * The same rows as `measurementUnitIdSql(alias) <comparison>`, written as an OR
 * of the two columns so the (tenantId, tankId, measuredAt) and (tenantId,
 * equipmentId, measuredAt) indexes serve it.
 */
export function measurementUnitMatchSql(alias: string, comparison: string): string {
  const tank = quotedColumn(alias, 'tankId');
  const equipment = quotedColumn(alias, 'equipmentId');
  return `(${tank} ${comparison} OR (${tank} IS NULL AND ${equipment} ${comparison}))`;
}
