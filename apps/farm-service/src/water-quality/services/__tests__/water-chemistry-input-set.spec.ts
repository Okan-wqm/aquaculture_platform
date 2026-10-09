import { isLoopHomogeneous, measuredQuantity } from '@aquaculture/shared-contracts';

import { SystemType } from '../../../system/entities/system.entity';
import {
  COHERENCE_WINDOW_MS,
  engineUnit,
  holdsSiteWater,
  isRecirculating,
  PAIRING_TOLERANCE_MS,
  SYSTEM_WATER_OF_TYPE,
  WATER_CHEMISTRY_INPUT_SETS,
  type WaterChemistryInputSet,
} from '../../data/water-chemistry-input-sets';
import type { ReadingCandidate, ResolvedReading } from '../reading-resolution';
import { evaluateInputSet, type InputFacts, type LoopFacts } from '../water-chemistry-input-set';

const AS_OF = new Date('2026-10-08T12:00:00Z');
const RAS: LoopFacts = { type: SystemType.RAS, volumeM3: 120, tankWaterM3: 80 };

function answered(
  point: ReadingCandidate['point'] = { kind: 'tank', id: 'tank-1' },
  observedAt: Date = AS_OF,
): ResolvedReading {
  return {
    value: 7.1,
    unit: 'pH',
    asOf: AS_OF,
    chosen: {
      kind: 'CHANNEL_PRIMARY',
      point,
      inherited: point.kind !== 'tank',
      sourceId: 'source-1',
      sensorId: 'sensor-1',
      channelKey: 'ph',
      measurementId: null,
      observedAt,
      quality: 'GOOD',
    },
    ageMs: 0,
    skipped: [],
    unresolved: null,
  };
}

const unanswered: ResolvedReading = {
  value: null,
  unit: 'pH',
  asOf: AS_OF,
  chosen: null,
  ageMs: null,
  skipped: [],
  unresolved: 'NO_SOURCE',
};

function allAnswered(set: WaterChemistryInputSet): InputFacts[] {
  return WATER_CHEMISTRY_INPUT_SETS[set].inputs.map((spec) => ({
    spec,
    parameter: { id: `config-${spec.quantity}`, effectiveQuantity: spec.quantity },
    reading: answered(),
  }));
}

describe('water-chemistry input sets (plan rev2 D3)', () => {
  it('reads exactly the engine’s measured inputs, in the engine’s units', () => {
    const units = (set: WaterChemistryInputSet): Record<string, string> =>
      Object.fromEntries(
        WATER_CHEMISTRY_INPUT_SETS[set].inputs.map((spec) => [spec.engineInput, engineUnit(spec)]),
      );
    // The units computeWaterChemistryOutputs computes in (shared-ui WaterChemistryInputs).
    expect(units('DOSING')).toEqual({
      pH: 'pH',
      alkalinityMg: 'mg/L CaCO3',
      tempC: '°C',
      salinity: 'ppt',
      caMgL: 'mg/L',
    });
    expect(units('TOXICITY')).toEqual({
      pH: 'pH',
      tempC: '°C',
      salinity: 'ppt',
      tan: 'mg/L',
      h2sUgL: 'µg/L',
    });
    expect(measuredQuantity('tan').basis).toBe('total ammonia as N');
    expect(WATER_CHEMISTRY_INPUT_SETS.DOSING.point).toBe('system');
    expect(WATER_CHEMISTRY_INPUT_SETS.TOXICITY.point).toBe('tank');
  });

  it('lets temperature and salinity inherit and never pH, TAN or H2S (the registry decides)', () => {
    const inherits = Object.fromEntries(
      WATER_CHEMISTRY_INPUT_SETS.TOXICITY.inputs.map((spec) => [
        spec.engineInput,
        isLoopHomogeneous(spec.quantity),
      ]),
    );
    expect(inherits).toEqual({ pH: false, tempC: true, salinity: true, tan: false, h2sUgL: false });
  });

  it('reads pH, temperature, TAN and H2S within hours, dosing alkalinity within a day, salinity and calcium within two', () => {
    const windows = Object.fromEntries(
      [
        ...WATER_CHEMISTRY_INPUT_SETS.DOSING.inputs,
        ...WATER_CHEMISTRY_INPUT_SETS.TOXICITY.inputs,
      ].map((spec) => [spec.engineInput, COHERENCE_WINDOW_MS[spec.window] / 3_600_000]),
    );
    expect(windows).toEqual({
      pH: 4,
      tempC: 4,
      tan: 4,
      h2sUgL: 4,
      alkalinityMg: 24,
      salinity: 48,
      caMgL: 48,
    });
  });

  it('is READY when every input has a value in a recirculating loop that holds its tanks', () => {
    const evaluation = evaluateInputSet('DOSING', RAS, allAnswered('DOSING'));
    expect(evaluation.verdict).toBe('READY');
    expect(evaluation.problems).toEqual([]);
    expect(evaluation.inputs.map((input) => input.windowMs)).toEqual([
      4 * 3_600_000,
      24 * 3_600_000,
      4 * 3_600_000,
      48 * 3_600_000,
      48 * 3_600_000,
    ]);
  });

  it('classifies every system type: only open water is inherited from the site, only a loop dosed', () => {
    const byWater = (water: string): SystemType[] =>
      Object.values(SystemType).filter((type) => SYSTEM_WATER_OF_TYPE[type] === water);
    expect(byWater('RECIRCULATING')).toEqual([
      SystemType.RAS,
      SystemType.BIOFLOC,
      SystemType.AQUAPONICS,
    ]);
    expect(byWater('OPEN')).toEqual([
      SystemType.FLOW_THROUGH,
      SystemType.POND,
      SystemType.CAGE,
      SystemType.RACEWAY,
    ]);
    expect(byWater('UNDECLARED')).toEqual([
      SystemType.HATCHERY,
      SystemType.NURSERY,
      SystemType.OTHER,
    ]);
    for (const type of Object.values(SystemType)) {
      expect(isRecirculating(type) && holdsSiteWater(type)).toBe(false);
    }
    expect(holdsSiteWater(SystemType.HATCHERY)).toBe(false);
    expect(isRecirculating(SystemType.HATCHERY)).toBe(false);
  });

  it('refuses a dosing recipe for water that leaves, or a loop of unknown or too small volume', () => {
    const refusal = (loop: LoopFacts): readonly string[] =>
      evaluateInputSet('DOSING', loop, allAnswered('DOSING')).problems;
    expect(refusal({ ...RAS, type: SystemType.FLOW_THROUGH })).toEqual([
      'SYSTEM_NOT_RECIRCULATING',
    ]);
    expect(refusal({ ...RAS, type: SystemType.OTHER, volumeM3: null })).toEqual([
      'SYSTEM_NOT_RECIRCULATING',
      'VOLUME_MISSING',
    ]);
    expect(refusal({ ...RAS, volumeM3: 0 })).toEqual(['VOLUME_MISSING']);
    expect(refusal({ ...RAS, volumeM3: 60 })).toEqual(['VOLUME_BELOW_TANK_WATER']);
    expect(evaluateInputSet('DOSING', { ...RAS, volumeM3: null }, []).verdict).toBe('REFUSED');
  });

  it('is INCOMPLETE when an input has no parameter or no value, naming which', () => {
    const inputs = allAnswered('TOXICITY').map((input) =>
      input.spec.quantity === 'tan'
        ? { ...input, parameter: null, reading: null }
        : input.spec.quantity === 'temperature'
          ? { ...input, reading: unanswered }
          : input,
    );
    const evaluation = evaluateInputSet('TOXICITY', null, inputs);
    expect(evaluation.verdict).toBe('INCOMPLETE');
    expect(evaluation.problems).toEqual(['INPUTS_INCOMPLETE']);
    expect(
      Object.fromEntries(
        evaluation.inputs.map((input) => [input.spec.engineInput, input.problems]),
      ),
    ).toEqual({ pH: [], tempC: ['NO_VALUE'], salinity: [], tan: ['NO_PARAMETER'], h2sUgL: [] });
  });

  it('wants H2S read where its pH was read', () => {
    const inputs = allAnswered('TOXICITY').map((input) =>
      input.spec.engineInput === 'h2sUgL'
        ? { ...input, reading: answered({ kind: 'tank', id: 'tank-2' }) }
        : input,
    );
    const evaluation = evaluateInputSet('TOXICITY', null, inputs);
    expect(evaluation.verdict).toBe('INCOMPLETE');
    expect(
      evaluation.inputs.find((input) => input.spec.engineInput === 'h2sUgL')?.problems,
    ).toEqual(['NOT_AT_SAME_POINT']);
  });

  it('wants H2S and its pH from one water sample: within 15 minutes of each other', () => {
    const h2sAt = (minutesBefore: number): InputFacts[] =>
      allAnswered('TOXICITY').map((input) =>
        input.spec.engineInput === 'h2sUgL'
          ? {
              ...input,
              reading: answered(
                { kind: 'tank', id: 'tank-1' },
                new Date(AS_OF.getTime() - minutesBefore * 60_000),
              ),
            }
          : input,
      );
    const h2sProblems = (minutesBefore: number): readonly string[] =>
      evaluateInputSet('TOXICITY', null, h2sAt(minutesBefore)).inputs.find(
        (input) => input.spec.engineInput === 'h2sUgL',
      )?.problems ?? ['missing input'];
    expect(PAIRING_TOLERANCE_MS).toBe(15 * 60_000);
    expect(h2sProblems(15)).toEqual([]);
    expect(h2sProblems(16)).toEqual(['NOT_SAME_SAMPLE']);
    expect(evaluateInputSet('TOXICITY', null, h2sAt(90)).verdict).toBe('INCOMPLETE');
  });
});
