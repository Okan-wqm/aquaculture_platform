import { ArgumentMetadata, BadRequestException, ValidationPipe } from '@nestjs/common';

import { ListPaymentsQueryDto } from '../dto/billing.dto';

/**
 * APA-087 — GET /billing/payments previously read every filter as a raw
 * `@Query('x')` string and interpolated `invoiceId`/`tenantId` as `$n::uuid`,
 * so a non-UUID value raised Postgres 22P02 → 500. Binding the request to
 * `ListPaymentsQueryDto` moves the failure to a 400 at the validation
 * boundary. These tests drive the SAME global ValidationPipe configuration as
 * production (see libs/backend-common create-service-app configureValidationPipe).
 */
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});

const queryMeta = (metatype: ArgumentMetadata['metatype']): ArgumentMetadata => ({
  type: 'query',
  metatype,
  data: '',
});

const VALID_UUID = '11111111-1111-4111-8111-111111111111';

describe('ListPaymentsQueryDto (APA-087)', () => {
  it('rejects a non-UUID invoiceId with 400 before it can reach the ::uuid cast', async () => {
    await expect(
      pipe.transform({ invoiceId: 'abc' }, queryMeta(ListPaymentsQueryDto)),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a pasted invoice NUMBER supplied as invoiceId', async () => {
    await expect(
      pipe.transform({ invoiceId: 'INV-202607-0001' }, queryMeta(ListPaymentsQueryDto)),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a non-UUID tenantId', async () => {
    await expect(
      pipe.transform({ tenantId: 'not-a-uuid' }, queryMeta(ListPaymentsQueryDto)),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('accepts a valid UUID invoiceId (the exact-UUID deep-link path)', async () => {
    const result = (await pipe.transform(
      { invoiceId: VALID_UUID },
      queryMeta(ListPaymentsQueryDto),
    )) as ListPaymentsQueryDto;
    expect(result).toBeInstanceOf(ListPaymentsQueryDto);
    expect(result.invoiceId).toBe(VALID_UUID);
  });

  it('accepts free-text search + comma status without treating them as a uuid', async () => {
    const result = (await pipe.transform(
      { search: 'INV-2026', status: 'succeeded,pending' },
      queryMeta(ListPaymentsQueryDto),
    )) as ListPaymentsQueryDto;
    expect(result.search).toBe('INV-2026');
    expect(result.status).toBe('succeeded,pending');
  });

  it('coerces limit to a number and enforces the 1..100 bound', async () => {
    const result = (await pipe.transform(
      { limit: '25' },
      queryMeta(ListPaymentsQueryDto),
    )) as ListPaymentsQueryDto;
    expect(result.limit).toBe(25);

    await expect(
      pipe.transform({ limit: '500' }, queryMeta(ListPaymentsQueryDto)),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an unknown query key (forbidNonWhitelisted)', async () => {
    await expect(
      pipe.transform({ bogus: 'x' }, queryMeta(ListPaymentsQueryDto)),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
