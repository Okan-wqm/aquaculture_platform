/**
 * WHY THIS FILE EXISTS:
 * GetShiftHandler is the backend for the FE `GetShift` query
 * (attendance.operations.ts → useShift). Before this handler the query 400'd
 * (GraphQL FE↔backend drift). These tests pin the handler contract:
 *  - returns the tenant-scoped shift by id (happy path)
 *  - throws NotFoundException when the shift is absent OR belongs to another
 *    tenant (the tenantId predicate hides it — tenant-isolation path)
 *  - the query carries the tenantId into the WHERE clause (no cross-tenant read)
 */
import { NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';

import { GetShiftHandler } from './get-shift.handler';
import { GetShiftQuery } from '../queries/get-shift.query';
import { Shift, ShiftType } from '../entities/shift.entity';

const tenantId = 'tenant-uuid-001';

const buildMockShift = (overrides: Partial<Shift> = {}): Shift => {
  const s = new Shift();
  Object.assign(s, {
    id: 'shift-uuid-001',
    tenantId,
    code: 'DAY',
    name: 'Day Shift',
    shiftType: ShiftType.REGULAR,
    startTime: '09:00',
    endTime: '17:00',
    totalMinutes: 480,
    isActive: true,
    isDeleted: false,
    version: 1,
    ...overrides,
  });
  return s;
};

interface MockQb {
  where: jest.Mock;
  andWhere: jest.Mock;
  getOne: jest.Mock;
}

const buildHandler = (getOneResult: Shift | null) => {
  const params: Record<string, unknown> = {};
  const qb: MockQb = {
    where: jest.fn().mockImplementation((_clause: string, p?: Record<string, unknown>) => {
      Object.assign(params, p);
      return qb;
    }),
    andWhere: jest.fn().mockImplementation((_clause: string, p?: Record<string, unknown>) => {
      Object.assign(params, p);
      return qb;
    }),
    getOne: jest.fn().mockResolvedValue(getOneResult),
  };

  const repo: Partial<Repository<Shift>> = {
    createQueryBuilder: jest.fn().mockReturnValue(qb),
  };

  const handler = new GetShiftHandler(repo as Repository<Shift>);
  return { handler, qb, params };
};

describe('GetShiftHandler', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns the tenant-scoped shift by id (happy path)', async () => {
    const shift = buildMockShift();
    const { handler, params } = buildHandler(shift);

    const result = await handler.execute(new GetShiftQuery(tenantId, 'shift-uuid-001'));

    expect(result).toBe(shift);
    // tenant-scoping: tenantId + id both bound into the query
    expect(params.tenantId).toBe(tenantId);
    expect(params.id).toBe('shift-uuid-001');
  });

  it('throws NotFoundException when the shift is absent or in another tenant', async () => {
    const { handler } = buildHandler(null);

    await expect(
      handler.execute(new GetShiftQuery(tenantId, 'missing-uuid')),
    ).rejects.toThrow(NotFoundException);
  });

  it('scopes the lookup to the calling tenant (no cross-tenant read)', async () => {
    const { handler, params } = buildHandler(buildMockShift());

    await handler.execute(new GetShiftQuery('tenant-uuid-OTHER', 'shift-uuid-001'));

    expect(params.tenantId).toBe('tenant-uuid-OTHER');
  });
});
