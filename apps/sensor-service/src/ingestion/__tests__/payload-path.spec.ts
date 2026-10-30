import { valueAtPath } from '../payload-path';

/**
 * A channel's dataPath names its value in a payload: dot segments, each
 * optionally indexing an array. Moved out of the MQTT listener so the legacy
 * route and the sensor-principal route read paths the same way.
 */
describe('valueAtPath', () => {
  it('reads nested values by dot notation', () => {
    expect(valueAtPath({ a: { b: { c: 42 } } }, 'a.b.c')).toBe(42);
  });

  it('reads array items by bracket notation', () => {
    expect(valueAtPath({ data: [10, 20, 30] }, 'data[1]')).toBe(20);
    expect(valueAtPath({ sensors: { mid: [1, 2] } }, 'sensors.mid[0]')).toBe(1);
  });

  it('is undefined for a missing path or one crossing a non-object', () => {
    expect(valueAtPath({ a: 1 }, 'b.c')).toBeUndefined();
    expect(valueAtPath({ a: 1 }, 'a.b')).toBeUndefined();
    expect(valueAtPath({ a: { b: 1 } }, 'a[0]')).toBeUndefined();
  });
});
