/**
 * WaterQualityMeasurement — quick-access column sync (FARM-MEDIUM-430)
 *
 * The single-ingress contract makes the JSONB parameter keys the parameter
 * CONFIG CODES (snake_case / lowercase: `dissolved_oxygen`, `ph` — see
 * parameter-templates.data.ts). syncQuickAccessFields() used to read the
 * legacy camelCase spellings (`dissolvedOxygen`, `pH`), so every ingested DO
 * and pH reading silently lost its quick-access decimal column. These specs
 * pin the config-code spelling as primary, with the legacy spellings kept as
 * fallback for rows written before the contract.
 */
import { WaterQualityMeasurement } from '../entities/water-quality-measurement.entity';

describe('WaterQualityMeasurement.syncQuickAccessFields — config-code keys', () => {
  it('syncQuickAccessFields reads snake_case parameter codes', () => {
    const m = new WaterQualityMeasurement();
    m.parameters = {
      temperature: 14,
      dissolved_oxygen: 8.2,
      ph: 7.4,
      ammonia: 0.1,
      nitrite: 0.05,
    };
    m.syncQuickAccessFields();
    expect(m.dissolvedOxygen).toBe(8.2);
    expect(m.pH).toBe(7.4);
    expect(m.temperature).toBe(14);
    expect(m.ammonia).toBe(0.1);
    expect(m.nitrite).toBe(0.05);
  });

  it('falls back to the legacy camelCase spellings for pre-contract rows', () => {
    const m = new WaterQualityMeasurement();
    m.parameters = { dissolvedOxygen: 7.9, pH: 7.1 };
    m.syncQuickAccessFields();
    expect(m.dissolvedOxygen).toBe(7.9);
    expect(m.pH).toBe(7.1);
  });

  it('prefers the config-code spelling when both spellings are present', () => {
    const m = new WaterQualityMeasurement();
    m.parameters = {
      dissolved_oxygen: 8.2,
      dissolvedOxygen: 1.1,
      ph: 7.4,
      pH: 6.0,
    };
    m.syncQuickAccessFields();
    expect(m.dissolvedOxygen).toBe(8.2);
    expect(m.pH).toBe(7.4);
  });

  it('leaves the quick-access columns unset when neither spelling is present', () => {
    const m = new WaterQualityMeasurement();
    m.parameters = { temperature: 14 };
    m.syncQuickAccessFields();
    expect(m.dissolvedOxygen).toBeUndefined();
    expect(m.pH).toBeUndefined();
  });
});
