/**
 * CreateSiteInput.totalArea — physical bounds (FARM-MEDIUM-398; 2026-09-21 live incident: a
 * site was saved with -50 m²). Pins the @Min(0) / @Max ceiling so removing
 * either fails here.
 */
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { CreateSiteInput } from '../create-site.input';

async function totalAreaErrors(totalArea: number): Promise<string[]> {
  const input = plainToInstance(CreateSiteInput, { name: 'North', code: 'N-01', totalArea });
  return (await validate(input)).map((error) => error.property);
}

describe('CreateSiteInput.totalArea', () => {
  it('accepts a realistic area', async () => {
    expect(await totalAreaErrors(12_500)).toEqual([]);
  });

  it.each([-50, 1_000_000_001])('refuses %p', async (totalArea) => {
    expect(await totalAreaErrors(totalArea)).toEqual(['totalArea']);
  });
});
