/**
 * WHY THIS FILE EXISTS:
 * GetCurrentRotationHandler / GetUpcomingRotationsHandler /
 * GetRotationCalendarHandler / GetRotationChangeoversHandler are the backends
 * for the FE `GetCurrentRotation` / `GetUpcomingRotations` / `GetRotationCalendar`
 * / `GetRotationChangeovers` queries that previously 400'd (GraphQL FE↔supergraph
 * drift). These tests pin:
 *  - current rotation: respects the rotation state machine's active states
 *    (IN_PROGRESS / EXTENDED), enriches daysRemaining + progressPercent, returns
 *    null when none
 *  - upcoming: only SCHEDULED, future, soonest-first, limit clamped
 *  - calendar: flattens employee/work-area display fields; rejects bad ranges
 *  - changeovers: groups outbound (startDate) + inbound (endDate) movements by
 *    day; rejects bad ranges
 *  - tenant scoping: every read carries the caller tenantId.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException } from '@nestjs/common';

import { GetCurrentRotationHandler } from '../get-current-rotation.handler';
import { GetUpcomingRotationsHandler } from '../get-upcoming-rotations.handler';
import { GetRotationCalendarHandler } from '../get-rotation-calendar.handler';
import { GetRotationChangeoversHandler } from '../get-rotation-changeovers.handler';
import { GetCurrentRotationQuery } from '../../queries/get-current-rotation.query';
import { GetUpcomingRotationsQuery } from '../../queries/get-upcoming-rotations.query';
import { GetRotationCalendarQuery } from '../../queries/get-rotation-calendar.query';
import { GetRotationChangeoversQuery } from '../../queries/get-rotation-changeovers.query';
import { WorkRotation, RotationStatus, RotationType, TransportMethod } from '../../entities/work-rotation.entity';
import { WorkArea } from '../../entities/work-area.entity';
import { Employee } from '../../../hr/entities/employee.entity';

const tenantId = 'tenant-uuid-001';

const buildQb = () => {
  const params: Record<string, unknown> = {};
  let oneResult: WorkRotation | null = null;
  let manyResult: WorkRotation[] = [];
  const qb: Record<string, jest.Mock> & {
    params: Record<string, unknown>;
    setOne: (r: WorkRotation | null) => void;
    setMany: (r: WorkRotation[]) => void;
  } = { params } as never;
  const chain = (...args: unknown[]) => {
    if (args[1] && typeof args[1] === 'object') Object.assign(params, args[1]);
    return qb;
  };
  qb.leftJoinAndSelect = jest.fn(chain);
  qb.where = jest.fn(chain);
  qb.andWhere = jest.fn(chain);
  qb.orderBy = jest.fn(chain);
  qb.take = jest.fn((n: number) => {
    params.__take = n;
    return qb;
  });
  qb.getOne = jest.fn(() => Promise.resolve(oneResult));
  qb.getMany = jest.fn(() => Promise.resolve(manyResult));
  qb.setOne = (r) => {
    oneResult = r;
  };
  qb.setMany = (r) => {
    manyResult = r;
  };
  return qb;
};

const buildEmployee = (): Employee => {
  const e = new Employee();
  Object.assign(e, { id: 'emp-1', tenantId, firstName: 'Ada', lastName: 'Lovelace', isDeleted: false });
  return e;
};

const buildArea = (overrides: Partial<WorkArea> = {}): WorkArea => {
  const wa = new WorkArea();
  Object.assign(wa, { id: 'wa-1', tenantId, name: 'Sea Pen 1', isOffshore: true, ...overrides });
  return wa;
};

// TypeORM `date` columns hydrate as 'YYYY-MM-DD' strings at runtime even though
// the entity types them as Date; the override type mirrors that so fixtures can
// use the same string form the handlers' toIsoDate() normalizes.
type RotationOverrides = Partial<Omit<WorkRotation, 'startDate' | 'endDate'>> & {
  startDate?: string;
  endDate?: string;
};

const buildRotation = (overrides: RotationOverrides = {}): WorkRotation => {
  const wr = new WorkRotation();
  Object.assign(wr, {
    id: 'wr-1',
    tenantId,
    employeeId: 'emp-1',
    workAreaId: 'wa-1',
    employee: buildEmployee(),
    workArea: buildArea(),
    rotationType: RotationType.OFFSHORE,
    status: RotationStatus.IN_PROGRESS,
    startDate: '2026-06-01',
    endDate: '2026-06-30',
    daysOn: 14,
    daysOff: 14,
    isDeleted: false,
    ...overrides,
  });
  return wr;
};

describe('GetCurrentRotationHandler', () => {
  let handler: GetCurrentRotationHandler;
  let qb: ReturnType<typeof buildQb>;

  beforeEach(async () => {
    qb = buildQb();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GetCurrentRotationHandler,
        { provide: getRepositoryToken(WorkRotation), useValue: { createQueryBuilder: jest.fn(() => qb) } },
      ],
    }).compile();
    handler = module.get(GetCurrentRotationHandler);
  });

  afterEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
  });

  it('returns the active rotation enriched with daysRemaining + progressPercent (happy path)', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-06-15T00:00:00.000Z'));
    qb.setOne(buildRotation({ startDate: '2026-06-01', endDate: '2026-06-30' }));

    const result = await handler.execute(new GetCurrentRotationQuery(tenantId, 'emp-1'));

    expect(result).not.toBeNull();
    expect(result?.daysRemaining).toBeGreaterThan(0);
    expect(result?.progressPercent).toBeGreaterThan(0);
    expect(result?.progressPercent).toBeLessThan(100);
    // active-state filter mirrors the rotation state machine in-flight states
    expect(qb.params.activeStatuses).toEqual([RotationStatus.IN_PROGRESS, RotationStatus.EXTENDED]);
    expect(qb.params.tenantId).toBe(tenantId);
  });

  it('returns null when the employee has no active rotation (validation path)', async () => {
    qb.setOne(null);
    const result = await handler.execute(new GetCurrentRotationQuery(tenantId, 'emp-1'));
    expect(result).toBeNull();
  });
});

describe('GetUpcomingRotationsHandler', () => {
  let handler: GetUpcomingRotationsHandler;
  let qb: ReturnType<typeof buildQb>;

  beforeEach(async () => {
    qb = buildQb();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GetUpcomingRotationsHandler,
        { provide: getRepositoryToken(WorkRotation), useValue: { createQueryBuilder: jest.fn(() => qb) } },
      ],
    }).compile();
    handler = module.get(GetUpcomingRotationsHandler);
  });

  afterEach(() => jest.clearAllMocks());

  it('returns SCHEDULED future rotations, tenant-scoped (happy path)', async () => {
    qb.setMany([buildRotation({ status: RotationStatus.SCHEDULED, startDate: '2026-08-01' })]);
    const result = await handler.execute(new GetUpcomingRotationsQuery(tenantId, 'emp-1', 5));
    expect(result).toHaveLength(1);
    expect(qb.params.status).toBe(RotationStatus.SCHEDULED);
    expect(qb.params.employeeId).toBe('emp-1');
    expect(qb.params.tenantId).toBe(tenantId);
  });

  it('clamps the limit to the 1..100 range (validation path)', async () => {
    qb.setMany([]);
    await handler.execute(new GetUpcomingRotationsQuery(tenantId, 'emp-1', 9999));
    expect(qb.params.__take).toBe(100);
  });
});

describe('GetRotationCalendarHandler', () => {
  let handler: GetRotationCalendarHandler;
  let qb: ReturnType<typeof buildQb>;

  beforeEach(async () => {
    qb = buildQb();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GetRotationCalendarHandler,
        { provide: getRepositoryToken(WorkRotation), useValue: { createQueryBuilder: jest.fn(() => qb) } },
      ],
    }).compile();
    handler = module.get(GetRotationCalendarHandler);
  });

  afterEach(() => jest.clearAllMocks());

  it('flattens employee + work-area display fields (happy path)', async () => {
    qb.setMany([buildRotation()]);
    const result = await handler.execute(
      new GetRotationCalendarQuery(tenantId, '2026-06-01', '2026-06-30'),
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: 'wr-1',
      employeeName: 'Ada Lovelace',
      workAreaName: 'Sea Pen 1',
      isOffshore: true,
      daysOn: 14,
    });
    expect(qb.params.tenantId).toBe(tenantId);
  });

  it('throws BadRequestException when endDate precedes startDate (validation path)', async () => {
    await expect(
      handler.execute(new GetRotationCalendarQuery(tenantId, '2026-06-30', '2026-06-01')),
    ).rejects.toThrow(BadRequestException);
  });
});

describe('GetRotationChangeoversHandler', () => {
  let handler: GetRotationChangeoversHandler;
  let qb: ReturnType<typeof buildQb>;

  beforeEach(async () => {
    qb = buildQb();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GetRotationChangeoversHandler,
        { provide: getRepositoryToken(WorkRotation), useValue: { createQueryBuilder: jest.fn(() => qb) } },
      ],
    }).compile();
    handler = module.get(GetRotationChangeoversHandler);
  });

  afterEach(() => jest.clearAllMocks());

  it('groups outbound (startDate) and inbound (endDate) movements by day (happy path)', async () => {
    qb.setMany([
      buildRotation({
        id: 'wr-A',
        startDate: '2026-06-05',
        endDate: '2026-06-19',
        outboundTransport: { method: TransportMethod.BOAT },
        inboundTransport: { method: TransportMethod.HELICOPTER },
      }),
    ]);
    const result = await handler.execute(
      new GetRotationChangeoversQuery(tenantId, '2026-06-01', '2026-06-30'),
    );

    const out = result.find((d) => d.date === '2026-06-05');
    const back = result.find((d) => d.date === '2026-06-19');
    expect(out?.goingOffshore[0]).toMatchObject({
      rotationId: 'wr-A',
      employeeName: 'Ada Lovelace',
      transportMethod: TransportMethod.BOAT,
    });
    expect(back?.returningOnshore[0]).toMatchObject({
      rotationId: 'wr-A',
      transportMethod: TransportMethod.HELICOPTER,
    });
    expect(qb.params.tenantId).toBe(tenantId);
  });

  it('throws BadRequestException on an invalid start date (validation path)', async () => {
    await expect(
      handler.execute(new GetRotationChangeoversQuery(tenantId, 'bad', '2026-06-30')),
    ).rejects.toThrow(BadRequestException);
  });
});
