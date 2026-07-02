import {
  TagRefParseError,
  buildTagRef,
  isTagRef,
  parseTagRef,
  splitTagRef,
  tagRefFromUnifiedTag,
  validateTagRef,
} from '../index';

describe('TagRef grammar', () => {
  describe('parseTagRef — valid forms', () => {
    it.each([
      'EDGE-AABB1122/tank1.do',
      'EDGE-AABB1122/tank1.temp',
      'edge01/pump_speed',
      'A/b',
      'DEV.01/DO-3',
      `${'D'.repeat(50)}/${'t'.repeat(50)}`,
    ])('accepts %s', (raw) => {
      expect(parseTagRef(raw)).toBe(raw);
      expect(isTagRef(raw)).toBe(true);
      expect(validateTagRef(raw)).toBe(true);
    });

    it('round-trips through splitTagRef and buildTagRef', () => {
      const ref = parseTagRef('EDGE-AABB1122/tank1.do');
      const { deviceCode, localName } = splitTagRef(ref);
      expect(deviceCode).toBe('EDGE-AABB1122');
      expect(localName).toBe('tank1.do');
      expect(buildTagRef(deviceCode, localName)).toBe(ref);
    });

    it('adopts a registry FQN', () => {
      expect(tagRefFromUnifiedTag({ fqn: 'EDGE-AABB1122/ph_sensor' })).toBe(
        'EDGE-AABB1122/ph_sensor',
      );
    });
  });

  describe('parseTagRef — rejected forms', () => {
    it.each([
      ['', 'empty'],
      ['tank1.do', 'no separator'],
      ['EDGE-1/tank/do', 'two separators'],
      ['/tank1.do', 'empty device segment'],
      ['EDGE-1/', 'empty local segment'],
      ['-EDGE/tank', 'device starts with dash'],
      ['EDGE 1/tank', 'whitespace in device'],
      ['EDGE-1/tank do', 'whitespace in local name'],
      ['EDGE-1/tank\n', 'trailing newline'],
      [`${'D'.repeat(51)}/tag`, 'device segment over 50 chars'],
      [`DEV/${'t'.repeat(51)}`, 'local segment over 50 chars'],
      ['gpio:17/x', 'colon in device segment'],
    ])('rejects %s (%s)', (raw) => {
      expect(() => parseTagRef(raw)).toThrow(TagRefParseError);
      expect(isTagRef(raw)).toBe(false);
      expect(validateTagRef(raw)).toBe(false);
    });

    it('reports the offending raw value in the error', () => {
      try {
        parseTagRef('bad value');
        fail('expected TagRefParseError');
      } catch (error) {
        expect(error).toBeInstanceOf(TagRefParseError);
        expect((error as TagRefParseError).raw).toBe('bad value');
      }
    });
  });

  describe('grammar ↔ schema parity', () => {
    it('regex and AJV validator agree on a fuzz sample', () => {
      const samples = [
        'EDGE-AABB1122/tank1.do',
        'a/b',
        'a//b',
        'nope',
        'DEV-1/ok_tag',
        'DEV-1/bad tag',
        'UPPER.lower-1_2/T.a-g_9',
      ];
      for (const sample of samples) {
        expect(validateTagRef(sample)).toBe(isTagRef(sample));
      }
    });
  });
});
