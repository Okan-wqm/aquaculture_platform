/**
 * Adapter: a configured card / flow-stage → the shared `WaterChemistryInputs` SSoT.
 *
 * Reads each parameter off explicit per-parameter sources (sensor reading or manual value)
 * and maps them onto the shared water-chemistry input shape consumed by the promoted
 * shared-ui charts via `computeWaterChemistryOutputs` / `buildDeffeyesData`. Returns null
 * when the core self-consistent tuple (temp/salinity/pH/alkalinity) is absent — the
 * engineReady guard, so a half-configured card/stage shows a message instead of garbage.
 *
 * MOCK note: connected sensor readings come from the mock READINGS table; the real phase
 * reads live values from sensor-service and limits from WaterQualityParameterConfig.
 */
import type { WaterChemistryInputs } from '@aquaculture/shared-ui';

import { READINGS } from './mock/fixtures';
import type { CardLimits, ParamKey, ParamSourceConfig, WcCard } from './types';

/** Read one parameter's value off an explicit source map (sensor reading or manual). */
export function sourceValue(sources: Record<ParamKey, ParamSourceConfig>, p: ParamKey): number | null {
  const src = sources[p];
  if (!src) return null;
  if (src.mode === 'manual') return src.value ?? null;
  const r = READINGS[`${src.sensorId}:${src.channelId}`];
  return r ? r.value : null;
}

/** Card-scoped convenience over {@link sourceValue}. */
export function cardValue(card: WcCard, p: ParamKey): number | null {
  return sourceValue(card.paramSources, p);
}

/**
 * Map explicit per-parameter sources + limits + volume onto the shared WaterChemistryInputs,
 * or null if the core tuple (temp/salinity/pH/alkalinity) is incomplete — the engineReady guard.
 * Used by both a point CARD and a system-card flow STAGE.
 */
export function sourcesToWaterChemistryInputs(
  sources: Record<ParamKey, ParamSourceConfig>,
  limits: CardLimits,
  volumeM3: number,
): WaterChemistryInputs | null {
  const tempC = sourceValue(sources, 'temperature');
  const pH = sourceValue(sources, 'ph');
  const salinity = sourceValue(sources, 'salinity');
  const alkalinityMg = sourceValue(sources, 'alkalinity');
  if (tempC == null || pH == null || salinity == null || alkalinityMg == null) return null;
  return {
    tempC,
    pH,
    salinity,
    alkalinityMg,
    targetpH: limits.targetPh,
    targetAlkalinityMg: limits.targetAlk,
    alkMinMg: limits.targetAlk * 0.6,
    alkMaxMg: limits.targetAlk * 1.4,
    tan: sourceValue(sources, 'tan') ?? limits.tan,
    unIonizedNH3: limits.nh3Limit,
    co2Toxic: limits.co2Toxic,
    h2sUgL: sourceValue(sources, 'h2s') ?? 0,
    h2sLimitUgL: limits.h2sLimitUgL,
    caMgL: sourceValue(sources, 'calcium') ?? limits.caMgL,
    volume: volumeM3,
    fishType: 'Arctic Charr',
    fishSize: '0-5 gram',
    showTarget: true,
  };
}

/** Point-card convenience over {@link sourcesToWaterChemistryInputs}. */
export function cardToWaterChemistryInputs(card: WcCard): WaterChemistryInputs | null {
  return sourcesToWaterChemistryInputs(card.paramSources, card.limits, card.volumeM3);
}
