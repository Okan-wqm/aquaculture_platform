import { describe, expect, it } from 'vitest';

import { DEFAULT_WATER_CHEMISTRY_INPUTS } from '../../defaults';
import type { WaterChemistryInputs } from '../../types';
import { applyResolved } from '../inputs-adapter';

import { dosingSet, input, toxicitySet } from './fixtures';

const BASE: WaterChemistryInputs = { ...DEFAULT_WATER_CHEMISTRY_INPUTS };

describe('applyResolved', () => {
  it('fills the covered fields from the set and keeps the entry for the rest (calculator)', () => {
    const applied = applyResolved(
      BASE,
      [dosingSet({ pH: 7.4, alkalinityMg: 120, tempC: 14, salinity: 30, caMgL: 380 }, 50)],
      { overrides: {}, uncovered: 'base' },
    );

    expect(applied.missing).toEqual([]);
    expect(applied.inputs).toMatchObject({
      pH: 7.4,
      alkalinityMg: 120,
      tempC: 14,
      salinity: 30,
      caMgL: 380,
      volume: 50,
      tan: BASE.tan,
      h2sUgL: BASE.h2sUgL,
      targetpH: BASE.targetpH,
    });
    expect(applied.provenance.pH.origin).toBe('resolved');
    expect(applied.provenance.pH.reading?.sensorId).toBe('sensor-1');
    expect(applied.provenance.volume.origin).toBe('resolved');
    expect(applied.provenance.tan.origin).toBe('manual');
  });

  it('never fills a covered field the set has no value for — not from the entry, not from a default', () => {
    const applied = applyResolved(
      BASE,
      [dosingSet({ pH: 7.4, alkalinityMg: null, tempC: 14, salinity: 30, caMgL: 380 }, null)],
      { overrides: {}, uncovered: 'base' },
    );

    expect(applied.inputs).toBeNull();
    expect(applied.missing).toEqual(['alkalinityMg', 'volume']);
    expect(applied.provenance.alkalinityMg).toMatchObject({
      origin: 'missing',
      value: null,
      set: 'DOSING',
    });
    expect(applied.provenance.alkalinityMg.input?.problems).toEqual(['NO_VALUE']);
  });

  it('takes a session override in place of a missing or measured value, and says so', () => {
    const applied = applyResolved(
      BASE,
      [dosingSet({ pH: 7.4, alkalinityMg: null, tempC: 14, salinity: 30, caMgL: 380 }, null)],
      { overrides: { alkalinityMg: 95, volume: 40, pH: 7.2 }, uncovered: 'base' },
    );

    expect(applied.missing).toEqual([]);
    expect(applied.inputs).toMatchObject({ alkalinityMg: 95, volume: 40, pH: 7.2 });
    expect(applied.provenance.pH.origin).toBe('override');
    expect(applied.provenance.pH.reading?.value).toBe(7.4);
    expect(BASE.alkalinityMg).toBe(DEFAULT_WATER_CHEMISTRY_INPUTS.alkalinityMg);
  });

  it('treats an uncovered field as missing when the base holds no entries (monitoring)', () => {
    const applied = applyResolved(
      BASE,
      [dosingSet({ pH: 7.4, alkalinityMg: 120, tempC: 14, salinity: 30, caMgL: 380 }, 50)],
      { overrides: {}, uncovered: 'missing' },
    );

    expect(applied.inputs).toBeNull();
    expect(applied.missing).toEqual(['tan', 'h2sUgL']);
  });

  it("reads the point's own set first and the loop's set after it", () => {
    const applied = applyResolved(
      BASE,
      [
        toxicitySet({ pH: 6.9, tempC: 15, salinity: 31, tan: 0.8, h2sUgL: 2 }),
        dosingSet({ pH: 7.4, alkalinityMg: 120, tempC: 14, salinity: 30, caMgL: 380 }, 50),
      ],
      { overrides: {}, uncovered: 'missing' },
    );

    expect(applied.missing).toEqual([]);
    expect(applied.inputs).toMatchObject({
      pH: 6.9,
      tempC: 15,
      tan: 0.8,
      alkalinityMg: 120,
      volume: 50,
    });
    expect(applied.provenance.pH.set).toBe('TOXICITY');
    expect(applied.provenance.alkalinityMg.set).toBe('DOSING');
  });

  it('ignores an engine input it does not know rather than guessing a field', () => {
    const set = dosingSet({ pH: 7.4, alkalinityMg: 120, tempC: 14, salinity: 30, caMgL: 380 }, 50);
    const applied = applyResolved(
      BASE,
      [{ ...set, inputs: [...set.inputs, input('magnesiumMgL', 1)] }],
      { overrides: {}, uncovered: 'base' },
    );
    expect(applied.missing).toEqual([]);
    expect(Object.keys(applied.provenance)).not.toContain('magnesiumMgL');
  });
});
