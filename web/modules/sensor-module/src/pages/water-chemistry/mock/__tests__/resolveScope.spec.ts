import { describe, expect, it } from 'vitest';

import type { ParamKey, ResolvedParameterSet } from '../../types';
import { resolveScope } from '../resolveScope';

const get = (set: ResolvedParameterSet, p: ParamKey): ResolvedParameterSet['values'][number] => {
  const v = set.values.find((x) => x.parameter === p);
  if (!v) throw new Error(`missing ${p}`);
  return v;
};

describe('resolveScope — cascade, provenance, staleness (mock)', () => {
  it('inherits a loop-level sensor for a tank (salinity resolves at loop, not tank)', async () => {
    const s = await resolveScope({ kind: 'tank', id: 't1' });
    const sal = get(s, 'salinity');
    expect(sal.resolvedLevel).toBe('loop'); // inherited, not terminal
    expect(sal.source).toBe('sensor');
    expect(sal.value).toBe(12);
  });

  it('honours a per-tank override (Tank A-3 has its own salinity)', async () => {
    const s = await resolveScope({ kind: 'tank', id: 't3' });
    const sal = get(s, 'salinity');
    expect(sal.resolvedLevel).toBe('tank');
    expect(sal.value).toBe(18);
  });

  it('does NOT loop-share for a flow-through system (Tank B-1 resolves per-tank)', async () => {
    const s = await resolveScope({ kind: 'tank', id: 't7' });
    const sal = get(s, 'salinity');
    expect(sal.resolvedLevel).toBe('tank'); // flow_through → no loop inheritance
    expect(sal.value).toBe(30);
  });

  it('derives freshness tiers from age + quality + offline', async () => {
    const t5 = await resolveScope({ kind: 'tank', id: 't5' });
    expect(get(t5, 'ph').freshness).toBe('stale'); // reading 42 min old
    expect(get(t5, 'dissolvedOxygen').freshness).toBe('bad-quality'); // quality 40
    const t7 = await resolveScope({ kind: 'tank', id: 't7' });
    expect(get(t7, 'dissolvedOxygen').freshness).toBe('offline');
  });

  it('CO₂ is derived (not fabricated) and H₂S falls back to the site binding', async () => {
    const s = await resolveScope({ kind: 'tank', id: 't1' });
    expect(get(s, 'co2').source).toBe('derived');
    expect(get(s, 'co2').value).toBeNull();
    const h2s = get(s, 'h2s');
    expect(h2s.resolvedLevel).toBe('site');
    expect(h2s.source).toBe('manual');
    expect(h2s.value).toBe(5);
  });

  it('a loop has NO single pH → engineReady false (no worst-case tuple can feed the engine)', async () => {
    const loop = await resolveScope({ kind: 'loop', id: 'loop-a' });
    expect(get(loop, 'ph').value).toBeNull();
    expect(loop.engineReady).toBe(false);
  });

  it('a tank with a complete core tuple is engineReady', async () => {
    const s = await resolveScope({ kind: 'tank', id: 't1' });
    expect(s.engineReady).toBe(true);
    expect(get(s, 'alkalinity').source).toBe('manual');
    expect(get(s, 'alkalinity').resolvedLevel).toBe('loop');
  });
});
