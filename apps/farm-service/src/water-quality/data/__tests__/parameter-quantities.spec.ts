import { isAcceptedUnit, measuredQuantity } from '@aquaculture/shared-contracts';
import { stub } from '@aquaculture/testing';
import type { Repository } from 'typeorm';

import { WaterQualityParameterConfig } from '../../entities/water-quality-parameter-config.entity';
import { WaterQualityParameterConfigSeederService } from '../../services/water-quality-parameter-config-seeder.service';
import {
  declarableQuantitiesOfParameter,
  PARAMETER_CODES,
  parameterCodeFamily,
  parameterQuantity,
  quantityOfParameterCode,
} from '../parameter-quantities';
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

  it('maps a code only to a quantity or family the registry defines', () => {
    for (const code of Object.keys(PARAMETER_CODES)) {
      for (const quantity of declarableQuantitiesOfParameter(code)) {
        expect(measuredQuantity(quantity).id).toBe(quantity);
      }
    }
    expect(quantityOfParameterCode('transparency')).toBeNull();
    // Recorded without a basis: no quantity until a basis is declared.
    expect(quantityOfParameterCode('ammonia')).toBeNull();
    expect(quantityOfParameterCode('nitrite')).toBeNull();
    expect(quantityOfParameterCode('constructor')).toBeNull();
    expect(parameterCodeFamily('ammonia')).toBe('ammonia');
  });

  it('takes a declaration only where the code allows it', () => {
    expect(parameterQuantity('ammonia', null)).toBeNull();
    expect(parameterQuantity('ammonia', 'tan')).toBe('tan');
    expect(parameterQuantity('ammonia', 'nitriteN')).toBeNull();
    expect(parameterQuantity('total_ammonia_nitrogen', null)).toBe('tan');
    expect(parameterQuantity('total_ammonia_nitrogen', 'nh3')).toBeNull();
    expect(parameterQuantity('conductivity', 'specificConductance')).toBe('specificConductance');
    // A custom code records nothing until declared, and may be declared as anything.
    expect(parameterQuantity('lab_probe_7', null)).toBeNull();
    expect(parameterQuantity('lab_probe_7', 'calcium')).toBe('calcium');
  });

  it('pins what each code means: effectiveQuantity is persisted from it', () => {
    // water_quality_parameter_configs.effectiveQuantity is derived from this
    // table on save and backfilled by migration 1822000000000. Changing what
    // an existing code means leaves stored configs on the old meaning: ship a
    // migration that re-derives effectiveQuantity in the same PR, then update
    // this pin. Adding a code is safe (new configs derive it on save), but
    // existing configs with that code need the same re-derivation.
    expect(PARAMETER_CODES).toEqual({
      temperature: { quantity: 'temperature' },
      ph: { quantity: 'ph' },
      dissolved_oxygen: { quantity: 'dissolvedOxygen' },
      oxygen_saturation: { quantity: 'oxygenSaturation' },
      salinity: { quantity: 'salinity' },
      conductivity: { quantity: 'conductivity', alternates: ['specificConductance'] },
      total_ammonia_nitrogen: { quantity: 'tan' },
      ammonia: { family: 'ammonia' },
      nitrite: { family: 'nitrite' },
      nitrate: { family: 'nitrate' },
      h2s: { quantity: 'h2s' },
      alkalinity: { quantity: 'alkalinity' },
      calcium: { quantity: 'calcium' },
      hardness: { quantity: 'hardness' },
      co2: { quantity: 'co2' },
      turbidity: { quantity: 'turbidity' },
      chlorine: { quantity: 'chlorine' },
      ozone: { quantity: 'ozone' },
    });
  });
});
