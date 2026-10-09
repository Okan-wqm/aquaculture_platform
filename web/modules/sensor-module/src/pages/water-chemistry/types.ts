/**
 * Water-chemistry monitoring — the one view preference the page keeps: which
 * chart a point panel draws. Everything measured comes from the farm API
 * (parameterSourcesAtPoint, waterChemistryInputs); nothing else is stored.
 */

/** Which chart a point panel renders. */
export type ChartType = 'deffeyes' | 'nh3' | 'h2s' | 'co2';

export const CHART_TYPES: readonly ChartType[] = ['deffeyes', 'nh3', 'h2s', 'co2'];

export function isChartType(value: unknown): value is ChartType {
  return typeof value === 'string' && (CHART_TYPES as readonly string[]).includes(value);
}
