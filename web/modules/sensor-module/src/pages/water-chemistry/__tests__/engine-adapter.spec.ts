import { describe, expect, it } from 'vitest';

import { toEngineInputs, tankStatus } from '../engine-adapter';
import { resolveScope } from '../mock/resolveScope';

describe('engine-adapter — inputs + tank status', () => {
  it('maps a tank self-consistent set to engine inputs', async () => {
    const t1 = await resolveScope({ kind: 'tank', id: 't1' });
    const inputs = toEngineInputs(t1);
    expect(inputs).not.toBeNull();
    expect(inputs?.pH).toBe(7.4);
    expect(inputs?.salinity).toBe(12);
    expect(inputs?.alkalinityMeq).toBeGreaterThan(0);
  });

  it('returns null for a loop with no single self-consistent set (no engine Frankenstein)', async () => {
    const loop = await resolveScope({ kind: 'loop', id: 'loop-a' });
    expect(toEngineInputs(loop)).toBeNull();
  });

  it('a clean tank is safe; a stale/low-DO tank is not', async () => {
    const t1 = await resolveScope({ kind: 'tank', id: 't1' });
    expect(tankStatus(t1).level).toBe('safe');

    const t5 = await resolveScope({ kind: 'tank', id: 't5' });
    expect(['alert', 'danger']).toContain(tankStatus(t5).level); // DO alert + bad-quality

    const t7 = await resolveScope({ kind: 'tank', id: 't7' });
    expect(tankStatus(t7).level).not.toBe('safe'); // DO sensor offline
  });
});
