/**
 * Persisted-schema forward-migration (prod-crash root cause).
 *
 * Cards/systems live in localStorage, so entries saved by an OLDER build can
 * miss fields added since. A pre-`paramSources` card crashed the page with
 * "Cannot read properties of undefined (reading 'temperature')". These specs
 * pin the load-boundary guard: stale shapes upgrade, garbage drops, current
 * shapes pass through untouched.
 */
import { describe, expect, it } from 'vitest';

import { cardToWaterChemistryInputs } from '../engine-adapter';
import { createSystemCard } from '../systemModel';
import { createCard, normalizeCard } from '../useWcCards';
import { normalizeSystem } from '../useWcSystems';

describe('normalizeCard — persisted point-card migration', () => {
  it('upgrades a legacy card WITHOUT paramSources instead of crashing the engine', () => {
    // Shape a pre-paramSources build persisted: no paramSources, no limits.
    const legacy = {
      id: 'legacy-1',
      title: 'Tank 1 · Outlet',
      scope: { kind: 'tank', id: 't1' },
      chartType: 'co2',
      layout: { x: 2, y: 3, w: 4, h: 8 },
    };

    const card = normalizeCard(legacy);

    expect(card).not.toBeNull();
    // User-visible bits preserved…
    expect(card?.id).toBe('legacy-1');
    expect(card?.title).toBe('Tank 1 · Outlet');
    expect(card?.chartType).toBe('co2');
    expect(card?.layout).toEqual({ x: 2, y: 3, w: 4, h: 8 });
    // …and the missing sections rebuilt: the exact read that crashed now works.
    expect(card?.paramSources.temperature).toBeDefined();
    expect(() => cardToWaterChemistryInputs(card as NonNullable<typeof card>)).not.toThrow();
  });

  it('drops unrecognizable garbage instead of trusting it', () => {
    expect(normalizeCard(null)).toBeNull();
    expect(normalizeCard('wat')).toBeNull();
    expect(normalizeCard({ id: 'x' })).toBeNull(); // no scope
    expect(normalizeCard({ scope: { kind: 'starship', id: 't1' } })).toBeNull();
  });

  it('passes a current-shape card through with its values intact', () => {
    const current = createCard({ kind: 'tank', id: 't1' });
    current.paramSources.temperature = { mode: 'manual', value: 11.5 };

    const card = normalizeCard(current);

    expect(card?.id).toBe(current.id);
    expect(card?.paramSources.temperature).toEqual({ mode: 'manual', value: 11.5 });
    expect(card?.limits).toEqual(current.limits);
  });
});

describe('normalizeSystem — persisted system migration', () => {
  it('rebuilds a system whose stages predate paramSources', () => {
    const legacy = {
      id: 'sys-legacy',
      kind: 'system',
      title: 'Loop A (renamed)',
      systemId: 'loop-a',
      flow: [{ id: 's1', kind: 'tank', label: 'T1', scope: { kind: 'tank', id: 't1' } }],
      activeStageId: 's1',
      dosingReferenceStageId: 's1',
    };

    const system = normalizeSystem(legacy);

    expect(system).not.toBeNull();
    expect(system?.title).toBe('Loop A (renamed)');
    for (const stage of system?.flow ?? []) {
      expect(stage.paramSources).toBeDefined();
      expect(typeof stage.enabled).toBe('boolean');
    }
    // The stage pointers now reference REAL stages of the rebuilt flow.
    const ids = new Set(system?.flow.map((s) => s.id));
    expect(ids.has(system?.activeStageId ?? '')).toBe(true);
    expect(ids.has(system?.dosingReferenceStageId ?? '')).toBe(true);
  });

  it('passes a current-shape system through as-is and drops non-systems', () => {
    const current = createSystemCard('loop-a');
    expect(normalizeSystem(current)?.id).toBe(current.id);
    expect(normalizeSystem({ systemId: 'loop-a' })).toBeNull(); // kind missing
  });
});
