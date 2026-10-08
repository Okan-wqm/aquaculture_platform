import { isAcceptedUnit, measuredQuantity } from '@aquaculture/shared-contracts';
import { stub } from '@aquaculture/testing';
import type { Repository } from 'typeorm';

import { WaterQualityParameterConfig } from '../../entities/water-quality-parameter-config.entity';
import { WaterQualityParameterConfigSeederService } from '../../services/water-quality-parameter-config-seeder.service';
import { PARAMETER_CODE_QUANTITY, quantityOfParameterCode } from '../parameter-quantities';
import { PARAMETER_TEMPLATES } from '../parameter-templates.data';

/**
 * A farm parameter that records a measured quantity reads in that quantity's
 * registry unit — in every template and in the tenant seed — so a sensor
 * channel and a manual entry for the same thing are in the same unit.
 */
describe('farm parameter codes and the measured-quantity registry', () => {
  const templateEntries = PARAMETER_TEMPLATES.flatMap((template) => template.parameters);
  const seeds = new WaterQualityParameterConfigSeederService(
    stub<Repository<WaterQualityParameterConfig>>({}),
  );

  it('writes every quantity-recording template parameter in the registry unit', () => {
    for (const entry of templateEntries) {
      const quantity = quantityOfParameterCode(entry.code);
      if (quantity !== null) {
        expect({ code: entry.code, unit: entry.unit }).toEqual({
          code: entry.code,
          unit: measuredQuantity(quantity).unit,
        });
      }
    }
  });

  it('seeds every quantity-recording parameter in the registry unit', () => {
    for (const seed of seeds.getDefaults()) {
      const quantity = quantityOfParameterCode(seed.code);
      if (quantity !== null) {
        expect({ code: seed.code, unit: seed.unit }).toEqual({
          code: seed.code,
          unit: measuredQuantity(quantity).unit,
        });
      }
    }
  });

  it('records the spellings the templates used to drift on in one form', () => {
    const unitOf = (code: string): string | undefined =>
      templateEntries.find((entry) => entry.code === code)?.unit;
    expect(unitOf('ph')).toBe('pH');
    expect(unitOf('alkalinity')).toBe('mg/L CaCO3');
    expect(unitOf('h2s')).toBe('µg/L');
    // The old spellings stay readable input for the same quantity.
    expect(isAcceptedUnit('alkalinity', 'mg/L CaCO₃')).toBe(true);
    expect(isAcceptedUnit('ph', '')).toBe(true);
  });

  it('maps a code only to a quantity the registry defines', () => {
    for (const quantity of Object.values(PARAMETER_CODE_QUANTITY)) {
      expect(measuredQuantity(quantity).id).toBe(quantity);
    }
    expect(quantityOfParameterCode('transparency')).toBeNull();
    // Recorded without a basis: not mapped until a basis is declared.
    expect(quantityOfParameterCode('ammonia')).toBeNull();
    expect(quantityOfParameterCode('nitrite')).toBeNull();
    expect(quantityOfParameterCode('constructor')).toBeNull();
  });
});
