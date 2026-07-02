/**
 * Adapter: a configured CARD → engine inputs.
 *
 * The engine (`@platform/aquaculture-engines`) is reused UNCHANGED. This is the only
 * glue: it reads each parameter off the card's explicit source (sensor reading or manual
 * value), maps them onto the engine's `WaterParams`/limits, and returns null when the
 * core self-consistent tuple (temp/salinity/pH/alkalinity) is absent — so a
 * half-configured card shows a message instead of a garbage operating point.
 *
 * MOCK note: connected sensor readings come from the mock READINGS table; the real phase
 * reads live values from sensor-service and limits from WaterQualityParameterConfig.
 */
import { alkMgToMeq } from '@platform/aquaculture-engines';

import { READINGS } from './mock/fixtures';
import type { ParamKey, WcCard } from './types';

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

/** Read one parameter's value off a card's explicit source (sensor reading or manual). */
export function cardValue(card: WcCard, p: ParamKey): number | null {
  const src = card.paramSources[p];
  if (!src) return null;
  if (src.mode === 'manual') return src.value ?? null;
  const r = READINGS[`${src.sensorId}:${src.channelId}`];
  return r ? r.value : null;
}

/**
 * Map an explicitly-configured CARD to engine inputs, or null if the core tuple
 * (temp/salinity/pH/alkalinity) is incomplete — the engineReady guard.
 */
export function cardToEngineInputs(card: WcCard): EngineInputs | null {
  const tempC = cardValue(card, 'temperature');
  const pH = cardValue(card, 'ph');
  const salinity = cardValue(card, 'salinity');
  const alkMg = cardValue(card, 'alkalinity');
  if (tempC == null || pH == null || salinity == null || alkMg == null) return null;
  return {
    tempC,
    pH,
    salinity,
    alkalinityMeq: alkMgToMeq(alkMg),
    tan: cardValue(card, 'tan') ?? card.limits.tan,
    nh3Limit: card.limits.nh3Limit,
    co2Toxic: card.limits.co2Toxic,
    caMgL: cardValue(card, 'calcium') ?? card.limits.caMgL,
    h2sUgL: cardValue(card, 'h2s') ?? 0,
    h2sLimitUgL: card.limits.h2sLimitUgL,
  };
}
