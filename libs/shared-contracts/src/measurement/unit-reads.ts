/**
 * The most units one many-unit read takes: farm's
 * `resolvedUnitParameterValues` and `effectiveUnitTemperatures` refuse more,
 * and a client with more units (a site's day plans) asks in batches of this
 * size (FE-LOW-365). One number for both sides, so a client's batch cannot
 * outgrow the server's bound.
 */
export const MAX_UNITS_PER_READ = 200;
