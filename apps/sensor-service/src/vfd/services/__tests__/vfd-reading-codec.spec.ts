import { mapParameterName, parseStatusWord, buildVfdReadResult } from '../vfd-reading-codec';
import { VfdRegisterMapping } from '../../entities/vfd-register-mapping.entity';
import { VfdEdgeReadValue } from '../vfd-edge-read.service';

function mapping(over: Partial<VfdRegisterMapping>): VfdRegisterMapping {
  return {
    parameterName: 'output_frequency',
    registerAddress: 100,
    registerCount: 1,
    functionCode: 3,
    scalingFactor: 0.1,
    offset: 0,
    ...over,
  } as VfdRegisterMapping;
}

function val(address: number, rawValue: number): VfdEdgeReadValue {
  return { name: 'x', address, rawValue };
}

describe('VfdReadingCodec', () => {
  describe('parseStatusWord (CiA 402)', () => {
    it('decodes running + fault bits', () => {
      const s = parseStatusWord(0x0004 | 0x0008); // bit 2 running + bit 3 fault
      expect(s.running).toBe(true);
      expect(s.fault).toBe(true);
      expect(s.warning).toBe(false);
    });

    it('inverts quick-stop and reads direction from bit 15', () => {
      expect(parseStatusWord(0x0000).quickStopActive).toBe(true); // bit 5 clear → active
      expect(parseStatusWord(0x0020).quickStopActive).toBe(false); // bit 5 set → not active
      expect(parseStatusWord(0x8000).direction).toBe('reverse');
      expect(parseStatusWord(0x0000).direction).toBe('forward');
    });
  });

  describe('mapParameterName', () => {
    it('maps known snake names to canonical camelCase keys', () => {
      expect(mapParameterName('output_frequency')).toBe('outputFrequency');
      expect(mapParameterName('status_word')).toBe('statusWord');
      expect(mapParameterName('kwh_counter')).toBe('energyConsumption');
    });

    it('returns null for unknown names', () => {
      expect(mapParameterName('mystery_param')).toBeNull();
    });
  });

  describe('buildVfdReadResult', () => {
    it('scales values, maps names, decodes the status word, and flags missing registers', () => {
      const mappings = [
        mapping({ parameterName: 'output_frequency', registerAddress: 100, scalingFactor: 0.1 }),
        mapping({ parameterName: 'status_word', registerAddress: 200, scalingFactor: 1 }),
        mapping({ parameterName: 'motor_current', registerAddress: 300, scalingFactor: 0.01 }),
      ];
      // Register 300 (motor_current) is NOT returned by the edge.
      const values = [val(100, 500), val(200, 0x0004)];

      const r = buildVfdReadResult(mappings, values, 7, new Date('2026-01-01T00:00:00.000Z'));

      expect(r.parameters.outputFrequency).toBeCloseTo(50.0); // 500 * 0.1
      expect(r.rawValues['output_frequency']).toBe(500);
      expect(r.parameters.statusWord).toBe(4);
      expect(r.statusBits.running).toBe(true);
      expect(r.latencyMs).toBe(7);

      // A missing register is an error, NEVER a fabricated zero.
      expect(r.errors).toEqual(expect.arrayContaining([expect.stringContaining('motor_current')]));
      expect(r.parameters.motorCurrent).toBeUndefined();
    });

    it('stores unmapped parameters under their raw name', () => {
      const r = buildVfdReadResult(
        [mapping({ parameterName: 'custom_thing', registerAddress: 100, scalingFactor: 1 })],
        [val(100, 42)],
        3,
        new Date('2026-01-01T00:00:00.000Z'),
      );
      expect((r.parameters as Record<string, number>)['custom_thing']).toBe(42);
      expect(r.errors).toBeUndefined();
    });
  });
});
