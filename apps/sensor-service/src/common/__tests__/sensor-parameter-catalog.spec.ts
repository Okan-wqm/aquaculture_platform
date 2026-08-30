import { ChannelDataType } from '../../database/entities/sensor-data-channel.entity';
import { SensorType } from '../../database/entities/sensor.entity';
import {
  lookupParameter,
  listParameterCatalog,
  SENSOR_PARAMETER_CATALOG,
} from '../sensor-parameter-catalog';

/**
 * SENSOR-MEDIUM-065: the single aquaculture parameter catalog. These lock the
 * canonical (server-side) values the FE now aligns to, and the alias behaviour.
 */
describe('sensor-parameter-catalog SSoT (SENSOR-MEDIUM-065)', () => {
  it('resolves keys case-insensitively', () => {
    expect(lookupParameter('Temperature')?.unit).toBe('°C');
    expect(lookupParameter('TEMPERATURE')?.max).toBe(40);
    expect(lookupParameter('nope')).toBeUndefined();
  });

  it('resolves aliases to the same definition as their canonical key', () => {
    expect(lookupParameter('temp')).toEqual(lookupParameter('temperature'));
    expect(lookupParameter('o2')).toEqual(lookupParameter('dissolved_oxygen'));
    expect(lookupParameter('ntu')).toEqual(lookupParameter('turbidity'));
    expect(lookupParameter('level')).toEqual(lookupParameter('water_level'));
  });

  it('carries the canonical server-side values the FE previously disagreed with', () => {
    expect(lookupParameter('water_level')).toMatchObject({ unit: 'cm', max: 500 });
    expect(lookupParameter('co2')).toMatchObject({ unit: 'mg/L', max: 100 });
    expect(lookupParameter('salinity')?.max).toBe(50);
    expect(lookupParameter('temperature')?.max).toBe(40);
  });

  it('every entry has a valid SensorType, non-empty unit, ordered range and NUMBER dataType', () => {
    const entries = listParameterCatalog();
    expect(entries).toHaveLength(Object.keys(SENSOR_PARAMETER_CATALOG).length);

    const validTypes = new Set<SensorType>(Object.values(SensorType));
    for (const e of entries) {
      expect(validTypes.has(e.sensorType)).toBe(true);
      expect(e.unit.length).toBeGreaterThan(0);
      expect(e.min).toBeLessThanOrEqual(e.max);
      expect(e.dataType).toBe(ChannelDataType.NUMBER);
      expect(e.key).toBe(e.key.toLowerCase());
    }
  });
});
