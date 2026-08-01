import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { AuditLogService } from '../../../../audit/audit-log.service';
import { RefreshToken } from '../../../authentication/entities/refresh-token.entity';
import { User } from '../../../authentication/entities/user.entity';
import { UserModuleAssignment } from '../../../authentication/entities/user-module-assignment.entity';
import { UserSiteAssignment } from '../../../authentication/entities/user-site-assignment.entity';
import { DurableUserTokenInvalidationService } from '../../../authentication/services/durable-user-token-invalidation.service';
import { Module as TenantModuleEntity } from '../../../system-module/entities/module.entity';
import { Tenant } from '../../entities/tenant.entity';
import { TenantModule } from '../../entities/tenant-module.entity';
import { FarmSiteAssignmentValidator } from '../farm-site-assignment-validator.service';
import { TenantAdminService } from '../tenant-admin.service';

/**
 * ORPHAN-MEDIUM-320 — unlockUser: the tenant-admin lockout recovery path.
 *
 * Before this mutation existed, the only remediation for a failed-login
 * lockout was raw SQL against auth.users (2026-07-02 incident: an operator
 * locked out for 30 minutes with a CORRECT password). These tests pin the
 * tenant scoping, the state reset, and the audit trail.
 */
describe('TenantAdminService.unlockUser', () => {
  const TENANT = '11111111-1111-4111-8111-111111111111';
  const OTHER_TENANT = '22222222-2222-4222-8222-222222222222';

  const mockUserRepository = {
    findOne: jest.fn(),
    save: jest.fn(),
  };
  const mockAuditLogService = { log: jest.fn().mockResolvedValue(undefined) };

  let service: TenantAdminService;

  const admin = Object.assign(new User(), {
    id: 'admin-1',
    email: 'admin@example.test',
    tenantId: TENANT,
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TenantAdminService,
        { provide: getRepositoryToken(Tenant), useValue: {} },
        { provide: getRepositoryToken(TenantModule), useValue: {} },
        { provide: getRepositoryToken(User), useValue: mockUserRepository },
        { provide: getRepositoryToken(UserModuleAssignment), useValue: {} },
        { provide: getRepositoryToken(UserSiteAssignment), useValue: {} },
        { provide: getRepositoryToken(TenantModuleEntity), useValue: {} },
        { provide: getRepositoryToken(RefreshToken), useValue: {} },
        { provide: DataSource, useValue: {} },
        { provide: AuditLogService, useValue: mockAuditLogService },
        { provide: FarmSiteAssignmentValidator, useValue: {} },
        { provide: DurableUserTokenInvalidationService, useValue: {} },
      ],
    }).compile();
    service = module.get(TenantAdminService);
  });

  it('clears failedLoginAttempts + lockedUntil and audits WHO unlocked WHOM', async () => {
    const locked = Object.assign(new User(), {
      id: 'user-1',
      email: 'locked@example.test',
      tenantId: TENANT,
      failedLoginAttempts: 6,
      lockedUntil: new Date('2026-07-02T12:29:52Z'),
    });
    mockUserRepository.findOne
      .mockResolvedValueOnce(admin)
      .mockResolvedValueOnce(locked);
    mockUserRepository.save.mockImplementation((u: User) => Promise.resolve(u));

    const saved = await service.unlockUser('admin-1', 'user-1');

    expect(saved.failedLoginAttempts).toBe(0);
    expect(saved.lockedUntil).toBeNull();
    expect(mockAuditLogService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'USER_UNLOCKED',
        performedBy: 'admin-1',
        entityId: 'user-1',
        tenantId: TENANT,
        details: expect.objectContaining({
          previousLockedUntil: '2026-07-02T12:29:52.000Z',
        }),
      }),
    );
  });

  it('scopes the target lookup to the ADMIN tenant — cross-tenant unlock is a NotFound', async () => {
    mockUserRepository.findOne
      .mockResolvedValueOnce(admin)
      // The tenant-scoped where clause finds nothing for a foreign user.
      .mockResolvedValueOnce(null);

    await expect(service.unlockUser('admin-1', 'foreign-user')).rejects.toThrow(
      NotFoundException,
    );
    expect(mockUserRepository.findOne).toHaveBeenNthCalledWith(2, {
      where: { id: 'foreign-user', tenantId: TENANT },
    });
    expect(mockUserRepository.save).not.toHaveBeenCalled();
  });

  it('rejects when the caller is not a tenant-bound admin', async () => {
    mockUserRepository.findOne.mockResolvedValueOnce(
      Object.assign(new User(), { id: 'platform-1', tenantId: null }),
    );

    await expect(service.unlockUser('platform-1', 'user-1')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('allows unlocking a TENANT_ADMIN target (lockout recovery requires a peer)', async () => {
    const lockedAdmin = Object.assign(new User(), {
      id: 'admin-2',
      email: 'admin2@example.test',
      tenantId: TENANT,
      role: 'TENANT_ADMIN',
      failedLoginAttempts: 5,
      lockedUntil: new Date(Date.now() + 60_000),
    });
    mockUserRepository.findOne
      .mockResolvedValueOnce(admin)
      .mockResolvedValueOnce(lockedAdmin);
    mockUserRepository.save.mockImplementation((u: User) => Promise.resolve(u));

    const saved = await service.unlockUser('admin-1', 'admin-2');
    expect(saved.lockedUntil).toBeNull();
  });

  // Explicitly NOT tested here: OTHER_TENANT constant documents the
  // cross-tenant case above — the scoping lives in the WHERE clause, which
  // the NthCalledWith assertion pins byte-for-byte.
  void OTHER_TENANT;
});
