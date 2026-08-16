import { BadRequestException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { isStandardPaginatedResult } from '@aquaculture/backend-common/pagination';

import { AuditLogService } from '../../../audit/audit.service';
import {
  ImpersonationPermission,
  ImpersonationSession,
  ImpersonationStatus,
} from '../../entities/impersonation-session.entity';
import { ImpersonationService } from '../impersonation.service';

function pageQuery() {
  return {
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
  };
}

describe('ImpersonationService server pagination query contract', () => {
  it('applies the history lifecycle scope and search before issuing a canonical page', async () => {
    const sessionQuery = pageQuery();
    const moduleRef = await Test.createTestingModule({
      providers: [
        ImpersonationService,
        {
          provide: getRepositoryToken(ImpersonationSession),
          useValue: { createQueryBuilder: jest.fn().mockReturnValue(sessionQuery) },
        },
        {
          provide: getRepositoryToken(ImpersonationPermission),
          useValue: {},
        },
        { provide: AuditLogService, useValue: {} },
      ],
    }).compile();

    const result = await moduleRef.get(ImpersonationService).querySessions({
      scope: 'history',
      search: 'operator@example.test',
      page: 2,
      limit: 20,
    });

    expect(isStandardPaginatedResult(result)).toBe(true);
    expect(sessionQuery.andWhere).toHaveBeenCalledWith('s.status IN (:...historyStatuses)', {
      historyStatuses: [
        ImpersonationStatus.ENDED,
        ImpersonationStatus.EXPIRED,
        ImpersonationStatus.TERMINATED,
      ],
    });
    expect(sessionQuery.andWhere).toHaveBeenCalledWith(
      expect.stringContaining('s.superAdminEmail ILIKE :search'),
      { search: '%operator@example.test%' },
    );
    expect(sessionQuery.skip).toHaveBeenCalledWith(20);
    expect(sessionQuery.take).toHaveBeenCalledWith(20);
  });

  it('rejects contradictory status and lifecycle scope instead of weakening either filter', async () => {
    const sessionQuery = pageQuery();
    const moduleRef = await Test.createTestingModule({
      providers: [
        ImpersonationService,
        {
          provide: getRepositoryToken(ImpersonationSession),
          useValue: { createQueryBuilder: jest.fn().mockReturnValue(sessionQuery) },
        },
        { provide: getRepositoryToken(ImpersonationPermission), useValue: {} },
        { provide: AuditLogService, useValue: {} },
      ],
    }).compile();

    await expect(
      moduleRef.get(ImpersonationService).querySessions({
        scope: 'history',
        status: ImpersonationStatus.ACTIVE,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(sessionQuery.getManyAndCount).not.toHaveBeenCalled();
  });

  it('queries permission status and administrator search on the server', async () => {
    const permissionQuery = pageQuery();
    const moduleRef = await Test.createTestingModule({
      providers: [
        ImpersonationService,
        { provide: getRepositoryToken(ImpersonationSession), useValue: {} },
        {
          provide: getRepositoryToken(ImpersonationPermission),
          useValue: { createQueryBuilder: jest.fn().mockReturnValue(permissionQuery) },
        },
        { provide: AuditLogService, useValue: {} },
      ],
    }).compile();

    const result = await moduleRef.get(ImpersonationService).queryPermissions({
      isActive: false,
      search: 'admin@example.test',
      page: 3,
      limit: 10,
    });

    expect(isStandardPaginatedResult(result)).toBe(true);
    expect(permissionQuery.andWhere).toHaveBeenCalledWith('p.isActive = :isActive', {
      isActive: false,
    });
    expect(permissionQuery.andWhere).toHaveBeenCalledWith(
      expect.stringContaining('p.superAdminEmail ILIKE :search'),
      { search: '%admin@example.test%' },
    );
    expect(permissionQuery.skip).toHaveBeenCalledWith(20);
    expect(permissionQuery.take).toHaveBeenCalledWith(10);
  });
});
