/**
 * Mock `resolveScope` — the cascade resolver (P0).
 *
 * Async on purpose (returns a Promise) so the UI's loading/error/keepPreviousData
 * states are real from day one; the real-phase swap replaces only this function body
 * with a typed GraphQL fetch. The SIGNATURE and return shape are the contract.
 *
 * Cascade (pinned per validation):
 *   axis = most-specific-non-null of  tank → loop(System) → site
 *   Site = tank.siteId (via department); Department is NOT a water tier.
 *   loop tier applies ONLY when the tank has a loopId AND System.type is a
 *   shared-water type (RAS/BIOFLOC/AQUAPONICS). Otherwise skip straight to tank/site.
 *   `inherit` is not terminal: we return the effective source + resolvedLevel.
 */
import type {
  Freshness,
  ParamKey,
  ParamSource,
  ResolvedLevel,
  ResolvedParameterSet,
  ResolvedValue,
  WcScope,
} from '../types';
import {
  ALL_PARAMS,
  BINDINGS,
  LOOPS,
  LOOP_SHARING_TYPES,
  READINGS,
  SITE,
  TANKS,
  UNITS,
  type BindingScope,
  type MockBinding,
  type MockTank,
} from './fixtures';

const SENSOR_STALE_MS = 15 * 60_000;
const MANUAL_STALE_MS = 24 * 60 * 60_000;

/** Core tuple the engine needs; all non-null ⇒ a self-consistent point exists. */
const ENGINE_CORE: ParamKey[] = ['temperature', 'salinity', 'ph', 'alkalinity'];

function freshnessOf(
  hasValue: boolean,
  source: ParamSource,
  asOf: string | undefined,
  quality: number | undefined,
  offline: boolean,
): Freshness {
  if (!hasValue) return 'n/a';
  if (offline) return 'offline';
  if (source === 'sensor' && quality != null && quality < 50) return 'bad-quality';
  const threshold = source === 'manual' ? MANUAL_STALE_MS : SENSOR_STALE_MS;
  if (asOf && Date.now() - Date.parse(asOf) > threshold) return 'stale';
  return 'fresh';
}

function findBinding(param: ParamKey, scopeType: BindingScope, scopeId: string): MockBinding | undefined {
  return BINDINGS.find(
    (b) => b.parameter === param && b.scopeType === scopeType && b.scopeId === scopeId,
  );
}

/** Resolve one parameter given an ordered candidate list of [level, scopeId]. */
function resolveParam(param: ParamKey, candidates: Array<[ResolvedLevel, string]>): ResolvedValue {
  // CO₂ is engine-derived (from pH+alk+temp) — not measured; value computed in the drill-down (P1).
  if (param === 'co2') {
    const level = candidates[0]?.[0] ?? 'site';
    return { parameter: param, value: null, unit: UNITS[param], source: 'derived', resolvedLevel: level, stale: false, freshness: 'n/a' };
  }

  for (const [level, scopeId] of candidates) {
    const binding = findBinding(param, level, scopeId);
    if (!binding) continue;

    if (binding.source === 'sensor') {
      const reading = READINGS[`${binding.sensorId}:${binding.channelId}`];
      const hasValue = reading != null;
      const offline = reading?.offline ?? !hasValue;
      const freshness = freshnessOf(hasValue, 'sensor', reading?.asOf, reading?.quality, offline);
      return {
        parameter: param,
        value: hasValue ? reading.value : null,
        unit: UNITS[param],
        source: 'sensor',
        resolvedLevel: level,
        sensorId: binding.sensorId,
        channelId: binding.channelId,
        asOf: reading?.asOf,
        quality: reading?.quality,
        stale: freshness !== 'fresh',
        freshness,
      };
    }

    // manual
    const hasValue = binding.manualValue != null;
    const freshness = freshnessOf(hasValue, 'manual', binding.manualAsOf, undefined, false);
    return {
      parameter: param,
      value: hasValue ? binding.manualValue ?? null : null,
      unit: UNITS[param],
      source: 'manual',
      resolvedLevel: level,
      asOf: binding.manualAsOf,
      stale: freshness !== 'fresh',
      freshness,
    };
  }

  // No binding anywhere → not measured. Never fabricate a value.
  const level = candidates[0]?.[0] ?? 'site';
  return { parameter: param, value: null, unit: UNITS[param], source: 'manual', resolvedLevel: level, stale: false, freshness: 'n/a' };
}

/** Ordered cascade candidates for a scope. */
function candidatesFor(scope: WcScope): Array<[ResolvedLevel, string]> {
  if (scope.kind === 'site') return [['site', scope.id]];

  if (scope.kind === 'loop') {
    const loop = LOOPS.find((l) => l.id === scope.id);
    return loop ? [['loop', loop.id], ['site', loop.siteId]] : [['loop', scope.id]];
  }

  // tank
  const tank = TANKS.find((t) => t.id === scope.id);
  if (!tank) return [['tank', scope.id]];
  const loop = tank.loopId ? LOOPS.find((l) => l.id === tank.loopId) : undefined;
  const loopSharing = !!loop && LOOP_SHARING_TYPES.has(loop.type);
  const chain: Array<[ResolvedLevel, string]> = [['tank', tank.id]];
  if (loopSharing && loop) chain.push(['loop', loop.id]);
  chain.push(['site', tank.siteId]);
  return chain;
}

function scopeName(scope: WcScope): string {
  if (scope.kind === 'site') return SITE.name;
  if (scope.kind === 'loop') return LOOPS.find((l) => l.id === scope.id)?.name ?? scope.id;
  return TANKS.find((t) => t.id === scope.id)?.name ?? scope.id;
}

/**
 * Resolve a full parameter set for a scope. MOCK today; the real backend returns the
 * same shape. `engineReady` is true only when the core tuple is fully present — a loop
 * with no single pH (pH is per-tank) resolves engineReady=false, which is exactly what
 * prevents a worst-case Frankenstein point from ever reaching the engine chart.
 */
export function resolveScope(scope: WcScope): Promise<ResolvedParameterSet> {
  const candidates = candidatesFor(scope);
  const values = ALL_PARAMS.map((p) => resolveParam(p, candidates));
  const byKey = new Map(values.map((v) => [v.parameter, v] as const));
  const engineReady = ENGINE_CORE.every((p) => byKey.get(p)?.value != null);

  return new Promise((res) => {
    // small delay mimics network latency so loading states exist from day one
    setTimeout(() => res({ scope, scopeName: scopeName(scope), values, engineReady }), 120);
  });
}

export interface ScopeOption {
  scope: WcScope;
  label: string;
}

/** Tanks belonging to a scope (a tank = itself; a loop/site = its member tanks). */
export function listTanksForScope(scope: WcScope): MockTank[] {
  if (scope.kind === 'tank') return TANKS.filter((t) => t.id === scope.id);
  if (scope.kind === 'loop') return TANKS.filter((t) => t.loopId === scope.id);
  return TANKS.filter((t) => t.siteId === scope.id);
}

/** Resolve every member tank of a scope (for the tank-status grid). MOCK today. */
export function resolveTanks(scope: WcScope): Promise<ResolvedParameterSet[]> {
  return Promise.all(
    listTanksForScope(scope).map((t) => resolveScope({ kind: 'tank', id: t.id })),
  );
}

/** The loop a tank belongs to (for drill-up navigation), or null. */
export function parentScopeOf(scope: WcScope): { scope: WcScope; label: string } | null {
  if (scope.kind !== 'tank') return null;
  const tank = TANKS.find((t) => t.id === scope.id);
  if (!tank?.loopId) return null;
  const loop = LOOPS.find((l) => l.id === tank.loopId);
  return loop ? { scope: { kind: 'loop', id: loop.id }, label: loop.name } : null;
}

/** Selectable scopes for the picker (site + every loop + every tank). */
export function listScopeOptions(): ScopeOption[] {
  return [
    { scope: { kind: 'site', id: SITE.id }, label: `Site — ${SITE.name}` },
    ...LOOPS.map((l) => ({ scope: { kind: 'loop' as const, id: l.id }, label: `Loop — ${l.name}` })),
    ...TANKS.map((t) => ({ scope: { kind: 'tank' as const, id: t.id }, label: `Tank — ${t.name}` })),
  ];
}
