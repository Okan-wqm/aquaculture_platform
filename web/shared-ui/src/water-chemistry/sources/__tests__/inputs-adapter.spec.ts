import { describe, expect, it } from 'vitest';

import { DEFAULT_WATER_CHEMISTRY_INPUTS } from '../../defaults';
import { composePointInputs, engineRecordOf } from '../inputs-adapter';

import { dosingSet, input, readyDosingInputs, readyToxicityInputs, toxicitySet } from './fixtures';

const SETTINGS = { ...DEFAULT_WATER_CHEMISTRY_INPUTS };

describe('composePointInputs', () => {
  it("reads a tank's own set and only the loop's alkalinity, calcium and volume from its system", () => {
    const composed = composePointInputs(
      {
        own: toxicitySet(readyToxicityInputs()),
        loop: dosingSet(readyDosingInputs(), { volumeM3: 50 }),
      },
      {},
    );
    expect(composed.fields.pH).toMatchObject({ state: 'measured', value: 6.9, from: 'point' });
    expect(composed.fields.alkalinityMg).toMatchObject({
      state: 'measured',
      value: 120,
      from: 'loop',
    });
    expect(composed.fields.caMgL).toMatchObject({ from: 'loop', value: 380 });
    expect(composed.fields.volume).toMatchObject({ state: 'configured', value: 50, from: 'loop' });
    // A tank never doses: the dose is the loop's.
    expect(composed.dosing).toEqual({ available: false, reason: 'NOT_A_LOOP', problems: [] });
  });

  it('blocks a value the backend keeps but flags (NOT_SAME_SAMPLE), and shows it with its problem', () => {
    const inputs = readyToxicityInputs().map((entry) =>
      entry.engineInput === 'h2sUgL' ? input('h2sUgL', 3.5, ['NOT_SAME_SAMPLE']) : entry,
    );
    const composed = composePointInputs({ own: toxicitySet(inputs), loop: null }, {});
    expect(composed.fields.h2sUgL).toMatchObject({
      state: 'blocked',
      value: null,
      problems: ['NOT_SAME_SAMPLE'],
    });
    expect(composed.fields.h2sUgL.reading?.value).toBe(3.5);
  });

  it('lets the operator correct a blocked field for the session', () => {
    const inputs = readyToxicityInputs().map((entry) =>
      entry.engineInput === 'h2sUgL' ? input('h2sUgL', 3.5, ['NOT_SAME_SAMPLE']) : entry,
    );
    const composed = composePointInputs({ own: toxicitySet(inputs), loop: null }, { h2sUgL: 2.5 });
    expect(composed.fields.h2sUgL).toMatchObject({ state: 'corrected', value: 2.5, problems: [] });
  });

  it('never uses the volume of a REFUSED dosing set, nor a zero volume', () => {
    const refused = composePointInputs(
      {
        own: dosingSet(readyDosingInputs(), {
          volumeM3: 80,
          verdict: 'REFUSED',
          problems: ['SYSTEM_NOT_RECIRCULATING'],
        }),
        loop: null,
      },
      {},
    );
    expect(refused.fields.volume).toMatchObject({
      state: 'blocked',
      value: null,
      problems: ['SYSTEM_NOT_RECIRCULATING'],
    });
    expect(refused.dosing).toMatchObject({ available: false, reason: 'NOT_READY' });

    const zero = composePointInputs(
      { own: dosingSet(readyDosingInputs(), { volumeM3: 0 }), loop: null },
      {},
    );
    expect(zero.fields.volume).toMatchObject({ state: 'blocked', problems: ['VOLUME_MISSING'] });
  });

  it('offers a dose only at a system whose dosing set is READY with a volume', () => {
    const ready = composePointInputs(
      { own: dosingSet(readyDosingInputs(), { volumeM3: 50 }), loop: null },
      {},
    );
    expect(ready.dosing).toEqual({ available: true });
    const incomplete = composePointInputs(
      {
        own: dosingSet([...readyDosingInputs().slice(0, 4), input('caMgL', null)], {
          volumeM3: 50,
          verdict: 'INCOMPLETE',
          problems: ['INPUTS_INCOMPLETE'],
        }),
        loop: null,
      },
      {},
    );
    expect(incomplete.dosing).toEqual({
      available: false,
      reason: 'NOT_READY',
      problems: ['INPUTS_INCOMPLETE'],
    });
  });

  it('never defaults a field no set covers: missing, unless the operator entered it', () => {
    const composed = composePointInputs(
      { own: dosingSet(readyDosingInputs(), { volumeM3: 50 }), loop: null },
      { tan: 0.4 },
    );
    expect(composed.fields.tan).toMatchObject({ state: 'entered', value: 0.4, from: null });
    expect(composed.fields.h2sUgL).toMatchObject({ state: 'missing', value: null });
  });
});

describe('engineRecordOf', () => {
  it('runs the engine only when every measured field is usable, and names what blocks it', () => {
    const composed = composePointInputs(
      { own: dosingSet(readyDosingInputs(), { volumeM3: 50 }), loop: null },
      {},
    );
    const record = engineRecordOf(composed, SETTINGS);
    expect(record.inputs).toBeNull();
    if (record.inputs === null) {
      expect(record.blocking.map((entry) => entry.field)).toEqual(['tan', 'h2sUgL']);
    }
  });

  it('is not blocked by a missing volume: the charts run, dosing is off', () => {
    const composed = composePointInputs(
      {
        own: toxicitySet(readyToxicityInputs()),
        loop: dosingSet(readyDosingInputs(), { volumeM3: null }),
      },
      {},
    );
    const record = engineRecordOf(composed, SETTINGS);
    expect(record.inputs).not.toBeNull();
    if (record.inputs !== null) {
      expect(record.dosing).toBe(false);
      expect(Number.isNaN(record.inputs.volume)).toBe(true);
      expect(record.inputs).toMatchObject({
        pH: 6.9,
        alkalinityMg: 120,
        targetpH: SETTINGS.targetpH,
      });
    }
  });

  it('carries the settings and the usable values, and doses at a READY system', () => {
    const composed = composePointInputs(
      { own: dosingSet(readyDosingInputs(), { volumeM3: 50 }), loop: null },
      { tan: 0.4, h2sUgL: 1 },
    );
    const record = engineRecordOf(composed, SETTINGS);
    expect(record.inputs).toMatchObject({ pH: 7.4, volume: 50, tan: 0.4, h2sUgL: 1 });
    expect(record.inputs !== null && record.dosing).toBe(true);
  });
});
