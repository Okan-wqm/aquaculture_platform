/**
 * Adapter: a configured CARD → the shared `WaterChemistryInputs` SSoT.
 *
 * Reads each parameter off the card's explicit source (sensor reading or manual value)
 * and maps it onto the shared water-chemistry input shape consumed by the promoted
 * shared-ui charts (DeffeyesChart + secondary charts) via `computeWaterChemistryOutputs`
 * / `buildDeffeyesData`. Returns null when the core self-consistent tuple
 * (temp/salinity/pH/alkalinity) is absent — the engineReady guard, so a half-configured
 * card shows a message instead of a garbage operating point.
 *
 * MOCK note: connected sensor readings come from the mock READINGS table; the real phase
 * reads live values from sensor-service and limits from WaterQualityParameterConfig.
 */
import type { WaterChemistryInputs } from '@aquaculture/shared-ui';

import { READINGS } from './mock/fixtures';
import type { ParamKey, WcCard } from './types';

/** Read one parameter's value off a card's explicit source (sensor reading or manual). */
export function cardValue(card: WcCard, p: ParamKey): number | null {
  const src = card.paramSources[p];
  if (!src) return null;
  if (src.mode === 'manual') return src.value ?? null;
  const r = READINGS[`${src.sensorId}:${src.channelId}`];
  return r ? r.value : null;
}

/**
 * Map an explicitly-configured CARD to the shared WaterChemistryInputs, or null if the
 * core tuple (temp/salinity/pH/alkalinity) is incomplete — the engineReady guard.
 */
export function cardToWaterChemistryInputs(card: WcCard): WaterChemistryInputs | null {
  const tempC = cardValue(card, 'temperature');
  const pH = cardValue(card, 'ph');
  const salinity = cardValue(card, 'salinity');
  const alkalinityMg = cardValue(card, 'alkalinity');
  if (tempC == null || pH == null || salinity == null || alkalinityMg == null) return null;
  const l = card.limits;
  return {
    tempC,
    pH,
    salinity,
    alkalinityMg,
    targetpH: l.targetPh,
    targetAlkalinityMg: l.targetAlk,
    alkMinMg: l.targetAlk * 0.6,
    alkMaxMg: l.targetAlk * 1.4,
    tan: cardValue(card, 'tan') ?? l.tan,
    unIonizedNH3: l.nh3Limit,
    co2Toxic: l.co2Toxic,
    h2sUgL: cardValue(card, 'h2s') ?? 0,
    h2sLimitUgL: l.h2sLimitUgL,
    caMgL: cardValue(card, 'calcium') ?? l.caMgL,
    volume: card.volumeM3,
    fishType: 'Arctic Charr',
    fishSize: '0-5 gram',
    showTarget: true,
  };
}
