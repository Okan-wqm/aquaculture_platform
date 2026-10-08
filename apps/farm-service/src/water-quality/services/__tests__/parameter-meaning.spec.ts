import { unitMeaningChanged } from '../parameter-meaning';

/**
 * A spelling of the same unit is not a change of meaning; a different unit
 * is. Prod configs still carry the old template spellings (pH as '',
 * alkalinity as 'mg/L CaCO₃') beside measurements, and re-applying the
 * template or correcting the spelling must not be refused for that.
 */
describe('unitMeaningChanged', () => {
  const ph = { code: 'ph', declaredQuantity: null };
  const alkalinity = { code: 'alkalinity', declaredQuantity: null };
  const temperature = { code: 'temperature', declaredQuantity: null };

  it('treats spellings of one unit as the same meaning', () => {
    expect(unitMeaningChanged(ph, '', 'pH')).toBe(false);
    expect(unitMeaningChanged(alkalinity, 'mg/L CaCO₃', 'mg/L CaCO3')).toBe(false);
    expect(unitMeaningChanged(temperature, '°C', '℃')).toBe(false);
    expect(unitMeaningChanged(temperature, '°C', ' °C ')).toBe(false);
  });

  it('treats another unit of the quantity, or a unit it cannot take, as a change', () => {
    expect(unitMeaningChanged(temperature, '°C', '°F')).toBe(true);
    expect(unitMeaningChanged(alkalinity, 'mg/L CaCO3', 'mg/L')).toBe(true);
    expect(unitMeaningChanged({ code: 'h2s', declaredQuantity: null }, 'µg/L', 'mg/L')).toBe(true);
  });

  it('reads an undeclared family by its members, and an unknown code by its strings', () => {
    expect(unitMeaningChanged({ code: 'ammonia', declaredQuantity: null }, 'mg/L', 'ppm')).toBe(
      false,
    );
    expect(unitMeaningChanged({ code: 'bod', declaredQuantity: null }, 'mg/L', 'mg/L')).toBe(false);
    expect(unitMeaningChanged({ code: 'transparency', declaredQuantity: null }, 'cm', 'm')).toBe(
      true,
    );
  });
});
