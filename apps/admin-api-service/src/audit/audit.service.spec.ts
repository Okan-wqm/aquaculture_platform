import { Logger } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Test } from '@nestjs/testing';
import { isStandardPaginatedResult } from '@aquaculture/backend-common/pagination';

import { AuditLog } from './audit.entity';
import { AuditLogService } from './audit.service';

function queryBuilder(result: Promise<[AuditLog[], number]>) {
  return {
    orderBy: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    getManyAndCount: jest.fn().mockReturnValue(result),
  };
}

async function serviceWithQuery(result: Promise<[AuditLog[], number]>): Promise<AuditLogService> {
  const moduleRef = await Test.createTestingModule({
    providers: [
      AuditLogService,
      {
        provide: getRepositoryToken(AuditLog),
        useValue: { createQueryBuilder: jest.fn().mockReturnValue(queryBuilder(result)) },
      },
    ],
  }).compile();

  return moduleRef.get(AuditLogService);
}

describe('AuditLogService query contract', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns only a factory-issued pagination result', async () => {
    const auditLog = new AuditLog();
    const service = await serviceWithQuery(Promise.resolve([[auditLog], 1]));

    const result = await service.query({}, 1, 20);

    expect(isStandardPaginatedResult(result)).toBe(true);
    expect(result.items).toEqual([auditLog]);
  });

  it('fails closed instead of representing a database failure as an empty page', async () => {
    const failure = new Error('audit database unavailable');
    const service = await serviceWithQuery(Promise.reject(failure));

    await expect(service.query({}, 1, 20)).rejects.toBe(failure);
  });
});

describe('AuditLogService required-write contract', () => {
  it('propagates persistence failure for transaction-bound security facts', async () => {
    const failure = new Error('audit write unavailable');
    const repository = {
      create: jest.fn().mockImplementation((value: AuditLog) => value),
      save: jest.fn().mockRejectedValue(failure),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [AuditLogService, { provide: getRepositoryToken(AuditLog), useValue: repository }],
    }).compile();
    const service = moduleRef.get(AuditLogService);

    await expect(
      service.logRequired({
        action: 'IMPERSONATION_PERMISSION_REVOKED',
        entityType: 'ImpersonationPermission',
        performedBy: 'operator-id',
      }),
    ).rejects.toBe(failure);
  });

  it('keeps explicitly best-effort logging tolerant while using the same writer', async () => {
    const repository = {
      create: jest.fn().mockImplementation((value: AuditLog) => value),
      save: jest.fn().mockRejectedValue(new Error('audit write unavailable')),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [AuditLogService, { provide: getRepositoryToken(AuditLog), useValue: repository }],
    }).compile();
    const service = moduleRef.get(AuditLogService);
    jest.spyOn(Logger.prototype, 'error').mockImplementation();

    await expect(
      service.log({
        action: 'NON_CRITICAL_TELEMETRY',
        entityType: 'Example',
        performedBy: 'operator-id',
      }),
    ).resolves.toBeNull();

    jest.restoreAllMocks();
  });
});
