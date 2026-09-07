/**
 * QueryReportsDto coercion — regression for ORPHAN-MEDIUM-148.
 *
 * GET /api/security/compliance/reports?limit=50 returned 400 because the DTO
 * declared `@IsNumber()` on `page`/`limit` without `@Type(() => Number)`. Query
 * params arrive as strings, so under the global ValidationPipe `@IsNumber` ran
 * against "50" and rejected every request that sent page/limit. These tests
 * pin the class-transformer coercion (the same pattern the sibling
 * audit-trail / security-monitoring controllers use).
 */
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { QueryReportsDto } from '../dto/compliance.dto';

describe('QueryReportsDto query coercion (ORPHAN-MEDIUM-148)', () => {
  it('coerces string query params (?page=2&limit=50) to numbers and validates clean', async () => {
    const dto = plainToInstance(QueryReportsDto, { page: '2', limit: '50' });

    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
    expect(dto.limit).toBe(50);
    expect(dto.page).toBe(2);
    expect(typeof dto.limit).toBe('number');
    expect(typeof dto.page).toBe('number');
  });

  it('still rejects a non-numeric limit', async () => {
    const dto = plainToInstance(QueryReportsDto, { limit: 'abc' });

    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'limit')).toBe(true);
  });

  it('accepts an absent limit (optional)', async () => {
    const dto = plainToInstance(QueryReportsDto, {});

    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
    expect(dto.limit).toBeUndefined();
  });
});
