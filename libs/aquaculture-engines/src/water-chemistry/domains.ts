/**
 * Shared pH domains for Deffeyes and water-chemistry solvers.
 *
 * Keep these values as the single source of truth so chart rendering, fallback
 * data, and compatibility wrappers do not drift.
 */
export interface DeffeyesPHDomain {
  minPH: number;
  maxPH: number;
}

export const DEFFEYES_CHART_PH_DOMAIN: Readonly<DeffeyesPHDomain> = Object.freeze({
  minPH: 4.0,
  maxPH: 12.5,
});

export const DEFFEYES_LEGACY_PH_DOMAIN: Readonly<DeffeyesPHDomain> = Object.freeze({
  minPH: 4.0,
  maxPH: 12.0,
});

export const DEFFEYES_SOLVER_PH_DOMAIN: Readonly<DeffeyesPHDomain> = Object.freeze({
  minPH: 0.0,
  maxPH: 14.0,
});

export const DEFFEYES_CHART_MAX_DIC = 8;
