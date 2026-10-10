/**
 * CreateSystemInput — physical bounds on capacity fields (FARM-MEDIUM-398; 2026-09-21 live
 * incident: a negative / overflowing volume reached the numeric column and the
 * create failed with a raw database error instead of a validation message).
 *
 * Each bound is pinned so removing it fails here: negative volume, biomass
 * and tank count are refused, a fractional tank count is refused, values past
 * the column-safe ceilings are refused, and a realistic system validates.
 */
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { SystemType } from '../../entities/system.entity';
import { CreateSystemInput } from '../create-system.input';

function systemPayload(overrides: Record<string, unknown> = {}): CreateSystemInput {
  return plainToInstance(CreateSystemInput, {
    siteId: '11111111-1111-4111-8111-111111111111',
    name: 'RAS Hall 1',
    code: 'RAS-1',
    type: SystemType.RAS,
    totalVolumeM3: 450,
    maxBiomassKg: 18_000,
    tankCount: 12,
    ...overrides,
  });
}

async function failingProperties(input: CreateSystemInput): Promise<string[]> {
  return (await validate(input)).map((error) => error.property);
}

describe('CreateSystemInput — capacity bounds', () => {
  it('accepts a realistic system', async () => {
    expect(await failingProperties(systemPayload())).toEqual([]);
  });

  it.each([
    ['totalVolumeM3', -1],
    ['totalVolumeM3', 1_000_000_001],
    ['maxBiomassKg', -0.5],
    ['maxBiomassKg', 1_000_000_001],
    ['tankCount', -1],
    ['tankCount', 100_001],
    ['tankCount', 2.5],
  ])('refuses %s = %p', async (property, value) => {
    expect(await failingProperties(systemPayload({ [property]: value }))).toEqual([property]);
  });

  it('accepts zero for the optional capacity fields', async () => {
    expect(
      await failingProperties(systemPayload({ totalVolumeM3: 0, maxBiomassKg: 0, tankCount: 0 })),
    ).toEqual([]);
  });
});
