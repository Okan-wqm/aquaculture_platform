/**
 * Sensor payload parser — the shared extraction engine (SENSOR-HIGH-082).
 */
import {
  normalizeChannelKey,
  isMetadataFieldKey,
  coerceChannelValue,
  extractValueAtPath,
  flattenJsonEntries,
  parseCsvEntries,
  parseTextEntries,
  parseBodyByFormat,
  extractReadingValues,
} from '../sensor-payload-parser';

describe('sensor-payload-parser', () => {
  describe('normalizeChannelKey', () => {
    it('lowercases, collapses non-alphanumerics, and trims underscores', () => {
      expect(normalizeChannelKey('Output Frequency')).toBe('output_frequency');
      expect(normalizeChannelKey('temp.C')).toBe('temp_c');
      expect(normalizeChannelKey('__weird--Key__')).toBe('weird_key');
    });
  });

  describe('isMetadataFieldKey', () => {
    it('flags transport/identity fields, not sensor channels', () => {
      expect(isMetadataFieldKey('timestamp')).toBe(true);
      expect(isMetadataFieldKey('Device_ID')).toBe(true);
      expect(isMetadataFieldKey('temperature')).toBe(false);
    });
  });

  describe('coerceChannelValue', () => {
    it('coerces numbers, numeric strings, booleans, and rejects unrepresentable values', () => {
      expect(coerceChannelValue(42)).toBe(42);
      expect(coerceChannelValue('42.5')).toBe(42.5);
      expect(coerceChannelValue('on')).toBe(true);
      expect(coerceChannelValue('off')).toBe(false);
      expect(coerceChannelValue('hello')).toBe('hello');
      expect(coerceChannelValue(null)).toBeNull();
      expect(coerceChannelValue({ a: 1 })).toBeNull();
      expect(coerceChannelValue(Number.NaN)).toBeNull();
    });
  });

  describe('extractValueAtPath', () => {
    const root = { data: { readings: { temp: 25.5 }, list: [{ v: 1 }, { v: 2 }] } };
    it('navigates object and array segments; missing paths yield undefined', () => {
      expect(extractValueAtPath(root, 'data.readings.temp')).toBe(25.5);
      expect(extractValueAtPath(root, 'data.list.1.v')).toBe(2);
      expect(extractValueAtPath(root, 'data.missing.x')).toBeUndefined();
      expect(extractValueAtPath(root, '')).toBe(root);
    });
  });

  describe('flattenJsonEntries', () => {
    it('recurses to dot-path leaves, takes first numeric of arrays, skips metadata', () => {
      const entries = flattenJsonEntries(
        {
          timestamp: '2026-01-01',
          temperature: 25.5,
          nested: { humidity: 60 },
          series: [1, 2, 3],
          label: 'ok',
        },
        '',
        isMetadataFieldKey,
      );
      const byPath = Object.fromEntries(entries.map((e) => [e.dataPath, e.value]));
      expect(byPath).toEqual({
        temperature: 25.5,
        'nested.humidity': 60,
        series: 1,
        label: 'ok',
      });
      // metadata excluded
      expect(byPath['timestamp']).toBeUndefined();
    });
  });

  describe('parseCsvEntries', () => {
    it('pairs a header row with the value row', () => {
      const entries = parseCsvEntries('temp,humidity\n25.5,60');
      expect(entries).toEqual([
        { key: 'temp', dataPath: 'temp', value: '25.5' },
        { key: 'humidity', dataPath: 'humidity', value: '60' },
      ]);
    });
    it('uses indexed keys when there is no header', () => {
      const entries = parseCsvEntries('1,2,3');
      expect(entries.map((e) => e.key)).toEqual(['value_0', 'value_1', 'value_2']);
    });
  });

  describe('parseTextEntries', () => {
    it('parses key=value pairs and a bare numeric single value', () => {
      expect(parseTextEntries('temp=25.5;humidity=60')).toEqual([
        { key: 'temp', dataPath: 'temp', value: '25.5' },
        { key: 'humidity', dataPath: 'humidity', value: '60' },
      ]);
      expect(parseTextEntries('42')).toEqual([{ key: 'value', dataPath: 'value', value: '42' }]);
      expect(parseTextEntries('not-a-number')).toEqual([]);
    });
  });

  describe('parseBodyByFormat', () => {
    it('parses json, extracts xml leaves, and passes csv/text through', () => {
      expect(parseBodyByFormat('{"a":1}', 'json')).toEqual({ a: 1 });
      expect(parseBodyByFormat('<r><temp>25</temp><hum>60</hum></r>', 'xml')).toEqual({
        temp: '25',
        hum: '60',
      });
      expect(parseBodyByFormat('a,b', 'csv')).toBe('a,b');
    });
    it('throws on malformed json so the read fails honestly', () => {
      expect(() => parseBodyByFormat('{not json', 'json')).toThrow();
    });
  });

  describe('extractReadingValues', () => {
    it('auto-flattens JSON under a dataPath, skipping metadata', () => {
      const raw = JSON.stringify({
        data: { temperature: 25.5, humidity: 60, timestamp: '2026' },
      });
      expect(
        extractReadingValues(raw, 'json', { dataPath: 'data', shouldSkip: isMetadataFieldKey }),
      ).toEqual({ temperature: 25.5, humidity: 60 });
    });

    it('applies an explicit dataMapping and omits paths that resolve to nothing', () => {
      const raw = JSON.stringify({ payload: { t: 25.5 } });
      expect(
        extractReadingValues(raw, 'json', {
          dataMapping: { water_temp: 'payload.t', missing: 'payload.nope' },
        }),
      ).toEqual({ water_temp: 25.5 });
    });

    it('extracts CSV and text bodies into coerced values', () => {
      expect(extractReadingValues('temp,ph\n25.5,7.2', 'csv')).toEqual({ temp: 25.5, ph: 7.2 });
      expect(extractReadingValues('do=8.1;temp=24', 'text')).toEqual({ do: 8.1, temp: 24 });
    });
  });
});
