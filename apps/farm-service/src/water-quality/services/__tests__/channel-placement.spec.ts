import { type FarmPlacement, placedAt, type SensorLocation } from '../channel-placement';

/**
 * Where a sensor stands, judged against farm's topology: the unit a sensor
 * names decides its system and site; a sensor naming no unit stands at its
 * system, else its site. A loop sensor never stands at one of its tanks.
 */
describe('placedAt', () => {
  const farm: FarmPlacement = {
    systemsOfUnit: new Map([
      ['tank-1', new Set(['loop-a'])],
      ['filter-1', new Set(['loop-a'])],
    ]),
    siteOfUnit: new Map([
      ['tank-1', 'site-1'],
      ['filter-1', 'site-1'],
    ]),
    siteOfSystem: new Map([['loop-a', 'site-1']]),
  };
  const sensor = (location: Partial<SensorLocation>): SensorLocation => ({
    siteId: null,
    systemId: null,
    tankId: null,
    equipmentId: null,
    ...location,
  });

  it('stands at a tank it names as tank or, from the wizard, as equipment', () => {
    expect(placedAt({ kind: 'tank', id: 'tank-1' }, sensor({ tankId: 'tank-1' }), farm)).toBe(true);
    expect(placedAt({ kind: 'tank', id: 'tank-1' }, sensor({ equipmentId: 'tank-1' }), farm)).toBe(
      true,
    );
    expect(placedAt({ kind: 'tank', id: 'tank-1' }, sensor({ tankId: 'tank-2' }), farm)).toBe(
      false,
    );
  });

  it('stands at equipment it names, and nowhere else', () => {
    expect(
      placedAt({ kind: 'equipment', id: 'filter-1' }, sensor({ equipmentId: 'filter-1' }), farm),
    ).toBe(true);
    expect(
      placedAt({ kind: 'equipment', id: 'filter-1' }, sensor({ tankId: 'filter-1' }), farm),
    ).toBe(false);
  });

  it('stands at a system through farm topology, which outranks the sensor’s own systemId', () => {
    const inLoop = sensor({ equipmentId: 'filter-1', systemId: 'loop-b' });
    expect(placedAt({ kind: 'system', id: 'loop-a' }, inLoop, farm)).toBe(true);
    expect(placedAt({ kind: 'system', id: 'loop-b' }, inLoop, farm)).toBe(false);
    expect(placedAt({ kind: 'system', id: 'loop-b' }, sensor({ systemId: 'loop-b' }), farm)).toBe(
      true,
    );
  });

  it('does not put a loop sensor at one of the loop’s tanks (inheritance is a reading rule)', () => {
    expect(placedAt({ kind: 'tank', id: 'tank-1' }, sensor({ systemId: 'loop-a' }), farm)).toBe(
      false,
    );
  });

  it('stands at a site through its unit, else its system, else its own site', () => {
    expect(
      placedAt({ kind: 'site', id: 'site-1' }, sensor({ tankId: 'tank-1', siteId: 'x' }), farm),
    ).toBe(true);
    expect(placedAt({ kind: 'site', id: 'site-1' }, sensor({ systemId: 'loop-a' }), farm)).toBe(
      true,
    );
    expect(placedAt({ kind: 'site', id: 'site-2' }, sensor({ siteId: 'site-2' }), farm)).toBe(true);
    expect(
      placedAt(
        { kind: 'site', id: 'site-2' },
        sensor({ tankId: 'tank-1', siteId: 'site-2' }),
        farm,
      ),
    ).toBe(false);
  });
});
