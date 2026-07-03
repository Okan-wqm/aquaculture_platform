import { describe, expect, it } from 'vitest';

import { isSystemCard } from '../types';
import { createSystemCard } from '../systemModel';

describe('createSystemCard (P4 system-card model)', () => {
  it('auto-includes ALL members: dosing-inlet + biofilter + every system tank', () => {
    const card = createSystemCard('loop-a');
    expect(isSystemCard(card)).toBe(true);
    // loop-a holds tanks t1, t2, t3, t5 → 2 loop stages + 4 tank stages
    const kinds = card.flow.map((s) => s.kind);
    expect(kinds.filter((k) => k === 'dosing-inlet')).toHaveLength(1);
    expect(kinds.filter((k) => k === 'biofilter')).toHaveLength(1);
    expect(kinds.filter((k) => k === 'tank')).toHaveLength(4);
    expect(card.flow.every((s) => s.enabled)).toBe(true);
  });

  it('doses at the biofilter-inlet reference (loop start/end)', () => {
    const card = createSystemCard('loop-a');
    const ref = card.flow.find((s) => s.id === card.dosingReferenceStageId);
    expect(ref?.kind).toBe('dosing-inlet');
  });

  it('seeds shared limits from the species template + a default reagent pair', () => {
    const card = createSystemCard('loop-a', 'tilapia');
    expect(card.shared.limits.nh3Limit).toBe(0.1);
    expect(card.shared.selectedReagents.length).toBeGreaterThanOrEqual(1);
  });

  it('each stage carries its own auto-bound param sources', () => {
    const card = createSystemCard('loop-a');
    const t1 = card.flow.find((s) => s.scope.id === 't1');
    expect(t1?.paramSources.ph.mode).toBe('sensor');
    expect(t1?.paramSources.ph.sensorId).toBe('PH-T1');
  });
});
