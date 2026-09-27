import 'reflect-metadata';
import { ToolSchemaValidatorService } from '../tool-schema-validator.service';

/**
 * JSON-Schema-spec conformance: every integer IS a valid number. LLMs emit
 * whole-number values for number-typed tool params (live finding: glm-5.3's
 * calculate_co2_level / calculate_ammonia_toxicity calls were all blocked
 * with "expected type number, got integer", starving the calculators).
 */
describe('ToolSchemaValidatorService — integer-as-number', () => {
  const service = new ToolSchemaValidatorService();

  const schema = {
    type: 'object',
    properties: {
      temperature: { type: 'number' },
      salinity: { type: 'number' },
      alkalinity: { type: 'number' },
    },
    required: ['temperature', 'salinity', 'alkalinity'],
    additionalProperties: false,
  };

  it('accepts integer values for number-typed parameters', () => {
    const result = service.validate(
      'calc',
      { temperature: 12, salinity: 0, alkalinity: 45 },
      schema,
    );
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('accepts float values for number-typed parameters (unchanged)', () => {
    const result = service.validate(
      'calc',
      { temperature: 12.5, salinity: 0.3, alkalinity: 45.0 },
      schema,
    );
    expect(result.valid).toBe(true);
  });

  it('still rejects genuinely wrong types (string for number)', () => {
    const result = service.validate(
      'calc',
      { temperature: 'twelve', salinity: 0, alkalinity: 45 },
      schema,
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('expected type number, got string');
  });
});
