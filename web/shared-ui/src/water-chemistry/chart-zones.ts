/**
 * pH-axis safety-band zone helpers (SSoT), clamped to the chart's visible pH domain.
 *
 * Moved verbatim from farm-module WaterChemistryPage. Recharts' default
 * `ifOverflow="discard"` silently drops off-domain `<ReferenceArea>`s, which made the
 * red/yellow/green shading vanish for edge inputs; these helpers always return an
 * in-domain band so the chart is always shaded.
 */
import { DEFFEYES_CHART_PH_DOMAIN } from '@platform/aquaculture-engines';

export interface VisiblePHZone {
  x1: number;
  x2: number;
}

export interface PHChartZones {
  danger?: VisiblePHZone;
  alert?: VisiblePHZone;
  safe?: VisiblePHZone;
  showCriticalLine: boolean;
}

export function getVisibleH2SChartZones(
  criticalPH: number,
  minPH = DEFFEYES_CHART_PH_DOMAIN.minPH,
  maxPH = DEFFEYES_CHART_PH_DOMAIN.maxPH,
): PHChartZones {
  if (!isFinite(criticalPH)) {
    return { safe: { x1: minPH, x2: maxPH }, showCriticalLine: false };
  }
  if (criticalPH < minPH) {
    return { safe: { x1: minPH, x2: maxPH }, showCriticalLine: false };
  }
  if (criticalPH >= maxPH) {
    return { danger: { x1: minPH, x2: maxPH }, showCriticalLine: criticalPH === maxPH };
  }

  const alertEnd = Math.min(maxPH, criticalPH + 0.2);
  return {
    danger: { x1: minPH, x2: criticalPH },
    alert: alertEnd > criticalPH ? { x1: criticalPH, x2: alertEnd } : undefined,
    safe: alertEnd < maxPH ? { x1: alertEnd, x2: maxPH } : undefined,
    showCriticalLine: true,
  };
}

/**
 * NH₃ safety bands for the UIA-vs-pH chart, clamped to the chart's visible pH
 * domain. NH₃ is toxic ABOVE the critical pH (mirror of H₂S), so the danger
 * band is on the high-pH (right) side.
 */
export function getVisibleNH3ChartZones(
  criticalPH: number,
  minPH = 6.0,
  maxPH = 9.5,
): PHChartZones {
  // No reachable critical pH, or it sits above the visible chart → all safe
  if (!isFinite(criticalPH) || criticalPH >= maxPH) {
    return { safe: { x1: minPH, x2: maxPH }, showCriticalLine: isFinite(criticalPH) && criticalPH === maxPH };
  }
  // Critical pH at/below the visible floor → whole chart is in the danger band
  if (criticalPH <= minPH) {
    return { danger: { x1: minPH, x2: maxPH }, showCriticalLine: criticalPH === minPH };
  }
  const alertStart = Math.max(minPH, criticalPH - 0.2);
  return {
    safe: alertStart > minPH ? { x1: minPH, x2: alertStart } : undefined,
    alert: alertStart < criticalPH ? { x1: alertStart, x2: criticalPH } : undefined,
    danger: { x1: criticalPH, x2: maxPH },
    showCriticalLine: true,
  };
}
