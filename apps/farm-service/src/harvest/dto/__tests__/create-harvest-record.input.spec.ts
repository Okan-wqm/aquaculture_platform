/**
 * CreateHarvestRecordInput — server-derived-identity regression guard
 *
 * FARM-HIGH-051: `harvestedBy` was declared `ID!` (required) on this input,
 * but the resolver derives the actor from `@CurrentUser` (user.sub →
 * CreateHarvestRecordCommand.recordedBy) and NEVER reads `input.harvestedBy`.
 * No client (AquaMobil PWA or web farm-module) sends it, so every harvest
 * mutation failed validation with a 400 before reaching the handler.
 *
 * The architectural fix DROPS the field entirely (tier-1: a value that cannot
 * be supplied cannot be spoofed or required). These tests pin that contract:
 *
 *   1. A payload built ONLY from the fields real clients send — no
 *      `harvestedBy` — validates with ZERO errors. This is the exact request
 *      shape that previously produced the 400.
 *   2. No class-validator metadata targets a `harvestedBy` property, so the
 *      required field cannot be silently re-introduced without failing here.
 */
import { getMetadataStorage, validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';

import { QualityClass } from '../../entities/harvest-record.entity';
import { CreateHarvestRecordInput } from '../create-harvest-record.input';

/**
 * The minimal mobile/web request body for `createHarvestRecord`. These are
 * exactly the fields web/modules/farm-module's CreateHarvestRecordInput and the
 * AquaMobil offline queue serialise — none of them is `harvestedBy`.
 */
function mobileHarvestPayload(): Record<string, unknown> {
  return {
    batchId: '11111111-1111-4111-8111-111111111111',
    tankId: '22222222-2222-4222-8222-222222222222',
    quantityHarvested: 400,
    averageWeight: 500,
    totalBiomass: 200,
    qualityClass: QualityClass.SUPERIOR,
    harvestDate: '2026-06-10T08:00:00.000Z',
  };
}

describe('CreateHarvestRecordInput — server-derived identity (FARM-HIGH-051)', () => {
  it('validates a client payload that omits harvestedBy (the former 400 case)', async () => {
    const input = plainToInstance(CreateHarvestRecordInput, mobileHarvestPayload());

    const errors = await validate(input, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });

    expect(errors).toHaveLength(0);
  });

  it('declares no validation metadata for a harvestedBy property', () => {
    const metadatas = getMetadataStorage().getTargetValidationMetadatas(
      CreateHarvestRecordInput,
      CreateHarvestRecordInput.name,
      false,
      false,
    );

    const properties = new Set(metadatas.map((m) => m.propertyName));
    expect(properties.has('harvestedBy')).toBe(false);
    // Sanity: the storage is actually populated for this class, so the
    // assertion above is meaningful and not vacuously true on an empty set.
    expect(properties.has('batchId')).toBe(true);
  });

  it('keeps harvestedBy off the instance even when a client tries to send it', async () => {
    // forbidNonWhitelisted means an attempt to spoof the actor is rejected
    // rather than silently ignored — attribution can only come from the JWT.
    const input = plainToInstance(CreateHarvestRecordInput, {
      ...mobileHarvestPayload(),
      harvestedBy: '99999999-9999-4999-8999-999999999999',
    });

    const errors = await validate(input, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });

    expect(errors).toHaveLength(1);
    expect(errors[0]?.property).toBe('harvestedBy');
  });
});
