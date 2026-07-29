import { describe, it, expect } from 'vitest';

import { inferChildSensorConfig, SensorType, ParameterCatalog } from '../registration.types';

/**
 * SENSOR-MEDIUM-065: inferChildSensorConfig prefills discovered child sensors from
 * the backend parameter-catalog SSoT — no more hardcoded FE map that disagreed on
 * units/ranges.
 */
const catalog: ParameterCatalog = {
  water_level: {
    key: 'water_level',
    sensorType: SensorType.WATER_LEVEL,
    label: 'Water Level',
    unit: 'cm',
    min: 0,
    max: 500,
  },
  ph: { key: 'ph', sensorType: SensorType.PH, label: 'pH', unit: 'pH', min: 0, max: 14 },
};

describe('inferChildSensorConfig (SENSOR-MEDIUM-065)', () => {
  it('prefills from the catalog with the canonical (backend) units/ranges', () => {
    const child = inferChildSensorConfig('water_level', 42, 'Tank A', catalog);
    expect(child.type).toBe(SensorType.WATER_LEVEL);
    // The canonical backend values — NOT the old FE map's 'm' / max 10.
    expect(child.unit).toBe('cm');
    expect(child.maxValue).toBe(500);
    expect(child.name).toBe('Tank A - Water Level');
  });

  it('normalizes hyphen/underscore keys before lookup', () => {
    const child = inferChildSensorConfig('water-level', 1, undefined, catalog);
    expect(child.type).toBe(SensorType.WATER_LEVEL);
    expect(child.unit).toBe('cm');
  });

  it('falls back to MULTI_PARAMETER with no prefill for an unknown key or empty catalog', () => {
    const unknown = inferChildSensorConfig('widget_count', 1, undefined, catalog);
    expect(unknown.type).toBe(SensorType.MULTI_PARAMETER);
    expect(unknown.unit).toBeUndefined();
    expect(unknown.minValue).toBeUndefined();
    expect(unknown.name).toBe('widget_count');

    const noCatalog = inferChildSensorConfig('ph', 7, undefined, {});
    expect(noCatalog.type).toBe(SensorType.MULTI_PARAMETER);
    expect(noCatalog.unit).toBeUndefined();
  });
});
