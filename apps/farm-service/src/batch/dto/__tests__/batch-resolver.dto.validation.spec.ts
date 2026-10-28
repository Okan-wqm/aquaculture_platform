/**
 * PLAT-HIGH-922 — the batch resolver inputs must pass the SAME validation pipe
 * every service registers globally (create-service-app: whitelist +
 * forbidNonWhitelisted + transform).
 *
 * A property that carries only `@Field` is "not whitelisted": any request that
 * sends it is rejected with "property X should not exist" while the schema
 * advertises the field. In production that turned the Feeding page's own
 * `batches(filter: { status, isActive })` call into a BAD_REQUEST on every tab,
 * and made `updateBatch` unusable. These tests drive the real pipe with the
 * variables the web app sends, so the failure mode is pinned at the boundary
 * where it happened, not at a decorator list.
 */
import { BadRequestException, ValidationPipe } from '@nestjs/common';

import { BatchInputType, BatchStatus } from '../../entities/batch.types';
import { BatchFilterInput, UpdateBatchInput } from '../batch-resolver.dto';

const SITE_ID = '2b4a8943-7760-4557-8cf9-6b9814746ba4';
const OTHER_ID = '8551d3fa-eea8-4e42-97c6-1e63f2b0018f';

/** Mirrors create-service-app's defaults (the farm-service passes no overrides). */
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  transformOptions: { enableImplicitConversion: false },
  validationError: { target: false, value: false },
});

async function bind<T extends object>(
  metatype: new () => T,
  value: Record<string, unknown>,
): Promise<T> {
  const bound: unknown = await pipe.transform(value, { type: 'body', metatype });
  return bound as T;
}

describe('BatchFilterInput under the global validation pipe (PLAT-HIGH-922)', () => {
  it('accepts an empty filter', async () => {
    await expect(bind(BatchFilterInput, {})).resolves.toBeInstanceOf(BatchFilterInput);
  });

  it('accepts the exact filter the Feeding page sends', async () => {
    const bound = await bind(BatchFilterInput, {
      status: [BatchStatus.ACTIVE, BatchStatus.GROWING, BatchStatus.PRE_HARVEST],
      isActive: true,
    });

    expect(bound.status).toEqual(['ACTIVE', 'GROWING', 'PRE_HARVEST']);
    expect(bound.isActive).toBe(true);
  });

  it.each([
    ['status', { status: [BatchStatus.CLOSED] }],
    ['speciesId', { speciesId: OTHER_ID }],
    ['inputType', { inputType: BatchInputType.FINGERLINGS }],
    ['supplierId', { supplierId: OTHER_ID }],
    ['tankId', { tankId: OTHER_ID }],
    ['siteId', { siteId: SITE_ID }],
    ['departmentId', { departmentId: OTHER_ID }],
    ['isActive', { isActive: false }],
    ['stockedAfter', { stockedAfter: new Date('2026-01-01T00:00:00Z') }],
    ['stockedBefore', { stockedBefore: new Date('2026-12-31T00:00:00Z') }],
    ['searchTerm', { searchTerm: 'B-2026' }],
  ])(
    'accepts %s on its own (each one used to be rejected as non-whitelisted)',
    async (_name, value) => {
      await expect(bind(BatchFilterInput, value)).resolves.toBeInstanceOf(BatchFilterInput);
    },
  );

  it.each([
    ['an unknown status', { status: ['ARCHIVED'] }],
    ['a status that is not a list', { status: 'ACTIVE' }],
    ['a non-UUID site id', { siteId: 'not-a-uuid' }],
    ['a non-boolean isActive', { isActive: 'yes' }],
    ['an unknown input type', { inputType: 'SPAWN' }],
    ['an invalid date', { stockedAfter: new Date('not-a-date') }],
    ['an over-long search term', { searchTerm: 'x'.repeat(201) }],
    ['a property the schema does not declare', { unknownProperty: 1 }],
  ])('rejects %s', async (_name, value) => {
    await expect(bind(BatchFilterInput, value)).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('UpdateBatchInput under the global validation pipe (PLAT-HIGH-922)', () => {
  it('accepts an id with every optional field', async () => {
    const bound = await bind(UpdateBatchInput, {
      id: OTHER_ID,
      name: 'Batch 7',
      expectedHarvestDate: new Date('2027-03-01T00:00:00Z'),
      targetFCR: 1.2,
      notes: 'moved to the grow-out hall',
    });

    expect(bound.id).toBe(OTHER_ID);
    expect(bound.targetFCR).toBe(1.2);
  });

  it('accepts an id alone (every other field is optional)', async () => {
    await expect(bind(UpdateBatchInput, { id: OTHER_ID })).resolves.toBeInstanceOf(
      UpdateBatchInput,
    );
  });

  it.each([
    ['a missing id', { name: 'x' }],
    ['a non-UUID id', { id: 'batch-7' }],
    ['an empty name', { id: OTHER_ID, name: '' }],
    ['an over-long name', { id: OTHER_ID, name: 'n'.repeat(256) }],
    ['a negative target FCR', { id: OTHER_ID, targetFCR: -1 }],
    ['a non-numeric target FCR', { id: OTHER_ID, targetFCR: 'low' }],
    ['an invalid harvest date', { id: OTHER_ID, expectedHarvestDate: new Date('nope') }],
    ['a property the schema does not declare', { id: OTHER_ID, status: 'CLOSED' }],
  ])('rejects %s', async (_name, value) => {
    await expect(bind(UpdateBatchInput, value)).rejects.toBeInstanceOf(BadRequestException);
  });
});
