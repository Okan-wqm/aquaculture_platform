import { latestInParameterUnit } from '../parameter-source-status.response';

describe('latestInParameterUnit', () => {
  const temperature = { effectiveQuantity: 'temperature', unit: '°C' };

  it("carries a channel's sample into the parameter's unit through the registry", () => {
    expect(latestInParameterUnit(temperature, { latestValue: 50, unit: '°F' })).toBeCloseTo(10, 6);
    expect(
      latestInParameterUnit(
        { effectiveQuantity: 'h2s', unit: 'µg/L' },
        { latestValue: 0.002, unit: 'mg/L' },
      ),
    ).toBeCloseTo(2, 6);
  });

  it('is null for a manual source, a channel without a sample or unit, or no quantity', () => {
    expect(latestInParameterUnit(temperature, null)).toBeNull();
    expect(latestInParameterUnit(temperature, { latestValue: null, unit: '°C' })).toBeNull();
    expect(latestInParameterUnit(temperature, { latestValue: 12, unit: null })).toBeNull();
    expect(
      latestInParameterUnit(
        { effectiveQuantity: null, unit: 'mg/L' },
        { latestValue: 1, unit: 'mg/L' },
      ),
    ).toBeNull();
  });

  it('is null when the channel unit is not a unit of the quantity', () => {
    expect(latestInParameterUnit(temperature, { latestValue: 12, unit: 'mg/L' })).toBeNull();
  });
});
