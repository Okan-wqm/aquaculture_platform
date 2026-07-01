/**
 * Adapter: a RESOLVED parameter set → engine inputs + a tank safety status.
 *
 * The engine (`@platform/aquaculture-engines`) is reused UNCHANGED. This adapter is
 * the only glue: it maps the resolved set onto the engine's `WaterParams`/limits and
 * returns null when the core self-consistent tuple is absent (so a loop with no single
 * pH never feeds the engine a worst-case Frankenstein point).
 *
 * MOCK note: site-level toxic limits / target ranges are hard-coded here for the mock;
 * the real phase reads them from `WaterQualityParameterConfig` (+ speciesLimits).
 */
import {
  alkMgToMeq,
  criticalPHforNH3,
  h2sStatus,
  criticalPHforH2SPHChartDomain,
  uiaStatus,
} from '@platform/aquaculture-engines';

import type { ParamKey, ResolvedParameterSet } from './types';

export const MOCK_SITE_LIMITS = {
  tan: 0.5,
  nh3Limit: 0.0125,
  co2Toxic: 40,
  h2sLimitUgL: 25,
  caMgL: 400,
} as const;

export interface EngineInputs {
  tempC: number;
  pH: number;
  salinity: number;
  alkalinityMeq: number;
  tan: number;
  nh3Limit: number;
  co2Toxic: number;
  caMgL: number;
  h2sUgL: number;
  h2sLimitUgL: number;
}

export type StatusLevel = 'safe' | 'alert' | 'danger' | 'unknown';

export interface TankStatus {
  level: StatusLevel;
  ph: number | null;
  dissolvedOxygen: number | null;
  reasons: string[];
}

function valueOf(set: ResolvedParameterSet, p: ParamKey): number | null {
  return set.values.find((v) => v.parameter === p)?.value ?? null;
}

/** Map a resolved set to engine inputs, or null if the core tuple is incomplete. */
export function toEngineInputs(set: ResolvedParameterSet): EngineInputs | null {
  if (!set.engineReady) return null;
  const tempC = valueOf(set, 'temperature');
  const pH = valueOf(set, 'ph');
  const salinity = valueOf(set, 'salinity');
  const alkMg = valueOf(set, 'alkalinity');
  if (tempC == null || pH == null || salinity == null || alkMg == null) return null;
  return {
    tempC,
    pH,
    salinity,
    alkalinityMeq: alkMgToMeq(alkMg),
    tan: valueOf(set, 'tan') ?? MOCK_SITE_LIMITS.tan,
    nh3Limit: MOCK_SITE_LIMITS.nh3Limit,
    co2Toxic: MOCK_SITE_LIMITS.co2Toxic,
    caMgL: MOCK_SITE_LIMITS.caMgL,
    h2sUgL: valueOf(set, 'h2s') ?? 0,
    h2sLimitUgL: MOCK_SITE_LIMITS.h2sLimitUgL,
  };
}

const worst = (a: StatusLevel, b: StatusLevel): StatusLevel => {
  const rank: Record<StatusLevel, number> = { unknown: 0, safe: 1, alert: 2, danger: 3 };
  return rank[a] >= rank[b] ? a : b;
};

/** Tank grid safety status: worst of NH₃ / DO / H₂S + a freshness downgrade. */
export function tankStatus(set: ResolvedParameterSet): TankStatus {
  const reasons: string[] = [];
  let level: StatusLevel = 'unknown';
  const ph = valueOf(set, 'ph');
  const doVal = valueOf(set, 'dissolvedOxygen');
  const inputs = toEngineInputs(set);

  if (inputs) {
    const critNH3 = criticalPHforNH3(inputs.tan, inputs.nh3Limit, inputs.tempC, inputs.salinity);
    const nh3 = uiaStatus(inputs.pH, critNH3);
    level = worst(level, nh3 === 'safe' ? 'safe' : nh3);
    if (nh3 !== 'safe') reasons.push(`NH₃ ${nh3}`);
    if (inputs.h2sUgL > 0) {
      const critH2S = criticalPHforH2SPHChartDomain(
        inputs.h2sUgL, inputs.pH, inputs.h2sLimitUgL, inputs.tempC, inputs.salinity,
      );
      const h2s = h2sStatus(inputs.pH, critH2S);
      level = worst(level, h2s === 'safe' ? 'safe' : h2s);
      if (h2s !== 'safe') reasons.push(`H₂S ${h2s}`);
    }
  }

  // DO band (mg/L): a genuine tank-specific safety signal the engine doesn't compute.
  if (doVal != null) {
    const doLevel: StatusLevel = doVal < 4 ? 'danger' : doVal < 6 ? 'alert' : 'safe';
    level = worst(level === 'unknown' ? 'safe' : level, doLevel);
    if (doLevel !== 'safe') reasons.push(`DO ${doVal.toFixed(1)} mg/L`);
  }

  // Freshness downgrade: any stale/offline/bad-quality reading can't be trusted as "safe".
  const badFreshness = set.values.some(
    (v) => v.value != null && (v.freshness === 'offline' || v.freshness === 'bad-quality'),
  );
  if (badFreshness) {
    level = worst(level === 'unknown' ? 'safe' : level, 'alert');
    reasons.push('stale/offline sensor');
  }

  return { level, ph, dissolvedOxygen: doVal, reasons };
}
