/**
 * CompleteHarvestPlanInput — the validated completion input (FARM-HIGH-395).
 *
 * The mutation took bare scalars the ValidationPipe never saw. These cases pin
 * the bounds (same as CreateHarvestRecordInput), the required quality class
 * (FARM-HIGH-396), and the 2-decimal limit that matches the stored
 * decimal(12,2) / decimal(10,2) columns, so a resent completion compares equal
 * to the stored one and replays idempotently instead of a 409.
 */
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { QualityClass } from '../../entities/harvest-record.entity';
import { CompleteHarvestPlanInput } from '../complete-harvest-plan.input';

function input(overrides: Record<string, unknown> = {}): CompleteHarvestPlanInput {
  return plainToInstance(CompleteHarvestPlanInput, {
    id: '11111111-1111-4111-8111-111111111111',
    actualQuantity: 400,
    actualBiomass: 20.5,
    actualAvgWeight: 51.25,
    qualityClass: QualityClass.ORDINAER,
    ...overrides,
  });
}

async function failing(value: CompleteHarvestPlanInput): Promise<string[]> {
  return (await validate(value)).map((error) => error.property);
}

describe('CompleteHarvestPlanInput', () => {
  it('accepts a counted completion', async () => {
    expect(await failing(input())).toEqual([]);
  });

  it.each([
    ['actualQuantity', 0],
    ['actualQuantity', 2.5],
    ['actualBiomass', 0],
    ['actualBiomass', -1],
    ['actualBiomass', 20.125],
    ['actualAvgWeight', 0],
    ['actualAvgWeight', 100001],
    ['actualAvgWeight', 51.255],
    ['qualityClass', undefined],
    ['qualityClass', 'grade_a'],
  ])('refuses %s = %p', async (property, value) => {
    expect(await failing(input({ [property]: value }))).toEqual([property]);
  });
});
