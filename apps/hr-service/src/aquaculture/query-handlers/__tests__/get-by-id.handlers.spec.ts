/**
 * WHY THIS FILE EXISTS:
 * GetWorkAreaHandler / GetWorkRotationHandler are the backends for the FE
 * `GetWorkArea` / `GetWorkRotation` queries which previously 400'd (GraphQL
 * FE↔supergraph drift — frontend built ahead of backend). These tests pin:
 *  - happy path returns the entity (work-rotation: with employee + workArea
 *    joins; work-area: with resolved requiredCertifications + currentAssignments)
 *  - NotFoundException when the id resolves to nothing (or another tenant's row,
 *    hidden by the tenantId predicate)
 *  - the query is tenant-scoped: every read carries the caller's tenantId.
 *
 * The handlers mirror the existing GetWorkAreasHandler / GetWorkRotationsHandler
 * read pattern (InjectRepository + explicit tenantId WHERE predicate). The
 * createQueryBuilder mock records the bound parameters so we can assert tenant
 * scoping on the actual query, not a stub of it.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NotFoundException } from '@nestjs/common';

import { GetWorkAreaHandler } from '../get-work-area.handler';
import { GetWorkRotationHandler } from '../get-work-rotation.handler';
import { GetWorkAreaQuery } from '../../queries/get-work-area.query';
import { GetWorkRotationQuery } from '../../queries/get-work-rotation.query';
import { WorkArea } from '../../entities/work-area.entity';
import { WorkRotation, RotationStatus, RotationType } from '../../entities/work-rotation.entity';
import { CertificationType } from '../../../training/entities/certification-type.entity';
import { Employee } from '../../../hr/entities/employee.entity';

const tenantId = 'tenant-uuid-001';

interface RecordingQueryBuilder {
  params: Record<string, unknown>;
  getOne: jest.Mock;
  getMany: jest.Mock;
}

const buildQueryBuilder = (result: {
  one?: unknown;
  many?: unknown[];
}): RecordingQueryBuilder & Record<string, jest.Mock> => {
  const params: Record<string, unknown> = {};
  const qb: Partial<RecordingQueryBuilder> & Record<string, jest.Mock> = {} as never;
  const chain = (...args: unknown[]): typeof qb => {
    // record bound parameters from where/andWhere(condition, params)
    const maybeParams = args[1];
    if (maybeParams && typeof maybeParams === 'object') {
      Object.assign(params, maybeParams);
    }
    return qb;
  };
  qb.leftJoinAndSelect = jest.fn(chain);
  qb.where = jest.fn(chain);
  qb.andWhere = jest.fn(chain);
  qb.orderBy = jest.fn(chain);
  qb.getOne = jest.fn().mockResolvedValue(result.one ?? null);
  qb.getMany = jest.fn().mockResolvedValue(result.many ?? []);
  (qb as RecordingQueryBuilder).params = params;
  return qb as RecordingQueryBuilder & Record<string, jest.Mock>;
};

const buildEmployee = (overrides: Partial<Employee> = {}): Employee => {
  const e = new Employee();
  Object.assign(e, {
    id: 'emp-uuid-001',
    tenantId,
    firstName: 'Ada',
    lastName: 'Lovelace',
    isDeleted: false,
    ...overrides,
  });
  return e;
};

describe('GetWorkAreaHandler', () => {
  let handler: GetWorkAreaHandler;
  let workAreaRepo: jest.Mocked<Repository<WorkArea>>;
  let rotationRepo: jest.Mocked<Repository<WorkRotation>>;
  let certTypeRepo: jest.Mocked<Repository<CertificationType>>;

  const buildWorkArea = (overrides: Partial<WorkArea> = {}): WorkArea => {
    const wa = new WorkArea();
    Object.assign(wa, {
      id: 'wa-uuid-001',
      tenantId,
      code: 'PEN-01',
      name: 'Sea Pen 1',
      isDeleted: false,
      isActive: true,
      requiredCertifications: [],
      ...overrides,
    });
    return wa;
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GetWorkAreaHandler,
        { provide: getRepositoryToken(WorkArea), useValue: { findOne: jest.fn() } },
        { provide: getRepositoryToken(WorkRotation), useValue: { createQueryBuilder: jest.fn() } },
        { provide: getRepositoryToken(CertificationType), useValue: { find: jest.fn() } },
      ],
    }).compile();

    handler = module.get(GetWorkAreaHandler);
    workAreaRepo = module.get(getRepositoryToken(WorkArea));
    rotationRepo = module.get(getRepositoryToken(WorkRotation));
    certTypeRepo = module.get(getRepositoryToken(CertificationType));
  });

  afterEach(() => jest.clearAllMocks());

  it('returns the area with resolved certifications and current assignments (happy path)', async () => {
    const workArea = buildWorkArea({ requiredCertifications: ['ct-1'] });
    workAreaRepo.findOne.mockResolvedValue(workArea);
    certTypeRepo.find.mockResolvedValue([{ id: 'ct-1', code: 'STCW', name: 'STCW BST' } as CertificationType]);

    const rotation = new WorkRotation();
    Object.assign(rotation, { id: 'wr-1', employee: buildEmployee(), status: RotationStatus.IN_PROGRESS });
    rotationRepo.createQueryBuilder.mockReturnValue(
      buildQueryBuilder({ many: [rotation] }) as never,
    );

    const result = await handler.execute(new GetWorkAreaQuery(tenantId, 'wa-uuid-001'));

    expect(result.id).toBe('wa-uuid-001');
    expect(result.requiredCertifications?.map((c) => c.id)).toEqual(['ct-1']);
    expect(result.currentAssignments).toHaveLength(1);
    expect(result.currentAssignments[0]).toMatchObject({ id: 'emp-uuid-001', firstName: 'Ada' });
  });

  it('throws NotFoundException when the area does not exist for the tenant', async () => {
    workAreaRepo.findOne.mockResolvedValue(null);
    await expect(handler.execute(new GetWorkAreaQuery(tenantId, 'missing'))).rejects.toThrow(
      NotFoundException,
    );
  });

  it('scopes the lookup to the caller tenant', async () => {
    workAreaRepo.findOne.mockResolvedValue(buildWorkArea());
    rotationRepo.createQueryBuilder.mockReturnValue(buildQueryBuilder({ many: [] }) as never);

    await handler.execute(new GetWorkAreaQuery(tenantId, 'wa-uuid-001'));

    expect(workAreaRepo.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ tenantId, id: 'wa-uuid-001', isDeleted: false }) }),
    );
  });
});

describe('GetWorkRotationHandler', () => {
  let handler: GetWorkRotationHandler;
  let rotationRepo: jest.Mocked<Repository<WorkRotation>>;

  const buildRotation = (): WorkRotation => {
    const wr = new WorkRotation();
    Object.assign(wr, {
      id: 'wr-uuid-001',
      tenantId,
      employeeId: 'emp-uuid-001',
      workAreaId: 'wa-uuid-001',
      rotationType: RotationType.OFFSHORE,
      status: RotationStatus.SCHEDULED,
      isDeleted: false,
    });
    return wr;
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GetWorkRotationHandler,
        { provide: getRepositoryToken(WorkRotation), useValue: { createQueryBuilder: jest.fn() } },
      ],
    }).compile();
    handler = module.get(GetWorkRotationHandler);
    rotationRepo = module.get(getRepositoryToken(WorkRotation));
  });

  afterEach(() => jest.clearAllMocks());

  it('returns the rotation when found (happy path)', async () => {
    rotationRepo.createQueryBuilder.mockReturnValue(buildQueryBuilder({ one: buildRotation() }) as never);
    const result = await handler.execute(new GetWorkRotationQuery(tenantId, 'wr-uuid-001'));
    expect(result.id).toBe('wr-uuid-001');
  });

  it('throws NotFoundException when missing (or other tenant)', async () => {
    rotationRepo.createQueryBuilder.mockReturnValue(buildQueryBuilder({ one: null }) as never);
    await expect(handler.execute(new GetWorkRotationQuery(tenantId, 'missing'))).rejects.toThrow(
      NotFoundException,
    );
  });

  it('binds the caller tenantId into the query', async () => {
    const qb = buildQueryBuilder({ one: buildRotation() });
    rotationRepo.createQueryBuilder.mockReturnValue(qb as never);
    await handler.execute(new GetWorkRotationQuery(tenantId, 'wr-uuid-001'));
    expect(qb.params.tenantId).toBe(tenantId);
    expect(qb.params.id).toBe('wr-uuid-001');
  });
});
