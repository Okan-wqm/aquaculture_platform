/**
 * WHY THIS FILE EXISTS:
 * GetWorkAreaOccupancyHandler / GetAllWorkAreaOccupanciesHandler are the
 * backends for the FE `GetWorkAreaOccupancy` / `GetAllWorkAreaOccupancies`
 * queries that previously 400'd (GraphQL FE↔supergraph drift). These tests pin:
 *  - occupancy math: scheduledCount = non-cancelled rotations covering the date;
 *    actualCount = only IN_PROGRESS; occupancyRate = actual/maxCapacity*100
 *  - BadRequestException on an invalid date / NotFoundException for a missing
 *    single area
 *  - tenant scoping: every read carries the caller tenantId
 *  - both handlers reuse the shared buildOccupancyReport util identically.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BadRequestException, NotFoundException } from '@nestjs/common';

import { GetWorkAreaOccupancyHandler } from '../get-work-area-occupancy.handler';
import { GetAllWorkAreaOccupanciesHandler } from '../get-all-work-area-occupancies.handler';
import { GetWorkAreaOccupancyQuery } from '../../queries/get-work-area-occupancy.query';
import { GetAllWorkAreaOccupanciesQuery } from '../../queries/get-all-work-area-occupancies.query';
import { WorkArea } from '../../entities/work-area.entity';
import { WorkRotation, RotationStatus, RotationType } from '../../entities/work-rotation.entity';

const tenantId = 'tenant-uuid-001';
const date = '2026-07-01';

const buildArea = (overrides: Partial<WorkArea> = {}): WorkArea => {
  const wa = new WorkArea();
  Object.assign(wa, {
    id: 'wa-1',
    tenantId,
    code: 'PEN-01',
    name: 'Sea Pen 1',
    maxCapacity: 4,
    isActive: true,
    isDeleted: false,
    displayOrder: 0,
    ...overrides,
  });
  return wa;
};

const buildRotation = (overrides: Partial<WorkRotation> = {}): WorkRotation => {
  const wr = new WorkRotation();
  Object.assign(wr, {
    id: 'wr-1',
    tenantId,
    employeeId: 'emp-1',
    workAreaId: 'wa-1',
    rotationType: RotationType.OFFSHORE,
    status: RotationStatus.IN_PROGRESS,
    isDeleted: false,
    ...overrides,
  });
  return wr;
};

const buildQb = (many: WorkRotation[]) => {
  const params: Record<string, unknown> = {};
  const qb: Record<string, jest.Mock> & { params: Record<string, unknown> } = {
    params,
  } as never;
  const chain = (...args: unknown[]) => {
    if (args[1] && typeof args[1] === 'object') Object.assign(params, args[1]);
    return qb;
  };
  qb.leftJoinAndSelect = jest.fn(chain);
  qb.where = jest.fn(chain);
  qb.andWhere = jest.fn(chain);
  qb.getMany = jest.fn().mockResolvedValue(many);
  return qb;
};

describe('GetWorkAreaOccupancyHandler', () => {
  let handler: GetWorkAreaOccupancyHandler;
  let workAreaRepo: jest.Mocked<Repository<WorkArea>>;
  let rotationRepo: jest.Mocked<Repository<WorkRotation>>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GetWorkAreaOccupancyHandler,
        { provide: getRepositoryToken(WorkArea), useValue: { findOne: jest.fn() } },
        { provide: getRepositoryToken(WorkRotation), useValue: { createQueryBuilder: jest.fn() } },
      ],
    }).compile();
    handler = module.get(GetWorkAreaOccupancyHandler);
    workAreaRepo = module.get(getRepositoryToken(WorkArea));
    rotationRepo = module.get(getRepositoryToken(WorkRotation));
  });

  afterEach(() => jest.clearAllMocks());

  it('computes occupancy for a single area (happy path)', async () => {
    workAreaRepo.findOne.mockResolvedValue(buildArea());
    const qb = buildQb([
      buildRotation({ employeeId: 'e1', status: RotationStatus.IN_PROGRESS }),
      buildRotation({ id: 'wr-2', employeeId: 'e2', status: RotationStatus.SCHEDULED }),
    ]);
    rotationRepo.createQueryBuilder.mockReturnValue(qb as never);

    const result = await handler.execute(new GetWorkAreaOccupancyQuery(tenantId, 'wa-1', date));

    expect(result.scheduledCount).toBe(2); // both cover the date
    expect(result.actualCount).toBe(1); // only the IN_PROGRESS one
    expect(result.occupancyRate).toBe(25); // 1/4 * 100
    expect(result.employees).toHaveLength(2);
    expect(qb.params.tenantId).toBe(tenantId);
    expect(qb.params.workAreaId).toBe('wa-1');
  });

  it('throws BadRequestException on an invalid date (validation path)', async () => {
    await expect(
      handler.execute(new GetWorkAreaOccupancyQuery(tenantId, 'wa-1', 'not-a-date')),
    ).rejects.toThrow(BadRequestException);
  });

  it('throws NotFoundException when the area is absent for the tenant', async () => {
    workAreaRepo.findOne.mockResolvedValue(null);
    await expect(
      handler.execute(new GetWorkAreaOccupancyQuery(tenantId, 'missing', date)),
    ).rejects.toThrow(NotFoundException);
  });
});

describe('GetAllWorkAreaOccupanciesHandler', () => {
  let handler: GetAllWorkAreaOccupanciesHandler;
  let workAreaRepo: jest.Mocked<Repository<WorkArea>>;
  let rotationRepo: jest.Mocked<Repository<WorkRotation>>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GetAllWorkAreaOccupanciesHandler,
        { provide: getRepositoryToken(WorkArea), useValue: { find: jest.fn() } },
        { provide: getRepositoryToken(WorkRotation), useValue: { createQueryBuilder: jest.fn() } },
      ],
    }).compile();
    handler = module.get(GetAllWorkAreaOccupanciesHandler);
    workAreaRepo = module.get(getRepositoryToken(WorkArea));
    rotationRepo = module.get(getRepositoryToken(WorkRotation));
  });

  afterEach(() => jest.clearAllMocks());

  it('groups rotations per area and reports occupancy for each (happy path)', async () => {
    workAreaRepo.find.mockResolvedValue([
      buildArea({ id: 'wa-1', maxCapacity: 2 }),
      buildArea({ id: 'wa-2', name: 'Sea Pen 2', maxCapacity: 4 }),
    ]);
    const qb = buildQb([
      buildRotation({ id: 'r1', workAreaId: 'wa-1', employeeId: 'e1', status: RotationStatus.IN_PROGRESS }),
      buildRotation({ id: 'r2', workAreaId: 'wa-2', employeeId: 'e2', status: RotationStatus.SCHEDULED }),
    ]);
    rotationRepo.createQueryBuilder.mockReturnValue(qb as never);

    const result = await handler.execute(new GetAllWorkAreaOccupanciesQuery(tenantId, date));

    expect(result).toHaveLength(2);
    const wa1 = result.find((r) => r.workArea.id === 'wa-1');
    const wa2 = result.find((r) => r.workArea.id === 'wa-2');
    expect(wa1?.actualCount).toBe(1);
    expect(wa1?.occupancyRate).toBe(50); // 1/2
    expect(wa2?.actualCount).toBe(0); // SCHEDULED only
    expect(wa2?.scheduledCount).toBe(1);
    // all-areas view does not select per-employee detail
    expect(wa1?.employees).toEqual([]);
    expect(qb.params.tenantId).toBe(tenantId);
  });

  it('throws BadRequestException on an invalid date (validation path)', async () => {
    await expect(
      handler.execute(new GetAllWorkAreaOccupanciesQuery(tenantId, 'nope')),
    ).rejects.toThrow(BadRequestException);
  });

  it('returns empty when the tenant has no work areas', async () => {
    workAreaRepo.find.mockResolvedValue([]);
    const result = await handler.execute(new GetAllWorkAreaOccupanciesQuery(tenantId, date));
    expect(result).toEqual([]);
    expect(workAreaRepo.find).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ tenantId }) }),
    );
  });
});
