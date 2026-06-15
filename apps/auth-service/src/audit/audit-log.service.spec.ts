import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { AuditLog, AuditLogSeverity } from './audit-log.entity';
import { AuditLogService } from './audit-log.service';

/**
 * AuditLogService.log — manager-aware overload coverage (FINDING #5 / SEC-MEDIUM-002)
 * ============================================================================
 *
 * # Why this spec exists
 *
 * The role-mutation tx blocks in tenant-user-management assert fail-CLOSED
 * audit: the audit row MUST roll back with the mutation. That guarantee only
 * holds if `log(dto, manager)` writes on the SAME connection as the enclosing
 * `dataSource.transaction(manager => ...)` block. The overload uses the
 * EntityManager entity-target `create(AuditLog, ...)` / `save(...)` (no
 * repository handle — that form trips the bare-getRepository gate), which binds
 * the write to the passed transaction. Before the overload `log()` always saved
 * on a separate injected-repository connection (fail-OPEN), so a rolled-back
 * role change left an orphan audit row.
 *
 * The specs below pin:
 *   1. `log(dto, manager)` writes via the PASSED manager, not the injected one.
 *   2. `log(dto)` (manager omitted) falls back to the injected repository's own
 *      manager — behaviour identical to the pre-overload implementation.
 *   3. The default-severity behaviour (undefined → INFO) is preserved on both
 *      paths.
 */
type ManagerMock = { create: jest.Mock; save: jest.Mock };

const makeManagerMock = (): ManagerMock => ({
  create: jest.fn((_target: unknown, shape: unknown) => shape),
  save: jest.fn((entity: unknown) => Promise.resolve(entity)),
});

describe('AuditLogService.log — manager-aware overload (FINDING #5)', () => {
  let service: AuditLogService;
  let injectedManager: ManagerMock;

  const dto = {
    tenantId: 'tenant-1',
    performedBy: 'user-1',
    action: 'USER_ROLE_CHANGED',
    entityType: 'UserRoleAssignment',
  };

  beforeEach(async () => {
    // The repository's OWN manager (fallback path when no manager is passed).
    injectedManager = makeManagerMock();

    const moduleRef = await Test.createTestingModule({
      providers: [
        AuditLogService,
        // useValue is untyped (DI any) — a structural { manager } double is
        // enough; the service only reaches auditLogRepository.manager.
        { provide: getRepositoryToken(AuditLog), useValue: { manager: injectedManager } },
        { provide: ConfigService, useValue: { get: jest.fn() } },
      ],
    }).compile();

    service = moduleRef.get(AuditLogService);
  });

  it('routes the write through the PASSED manager (atomic / fail-CLOSED)', async () => {
    const txManager = makeManagerMock();

    await service.log(dto, txManager);

    // The passed manager performs the write, scoped to the AuditLog entity...
    expect(txManager.create).toHaveBeenCalledWith(AuditLog, expect.objectContaining({ action: dto.action }));
    expect(txManager.save).toHaveBeenCalledTimes(1);
    // ...and the injected manager is NEVER touched (no separate connection —
    // this is what makes the audit atomic with the rolled-back mutation).
    expect(injectedManager.create).not.toHaveBeenCalled();
    expect(injectedManager.save).not.toHaveBeenCalled();
  });

  it('falls back to the injected repository manager when no manager is passed (unchanged behaviour)', async () => {
    await service.log(dto);

    expect(injectedManager.create).toHaveBeenCalledWith(AuditLog, expect.objectContaining({ action: dto.action }));
    expect(injectedManager.save).toHaveBeenCalledTimes(1);
  });

  it('defaults severity to INFO when the DTO omits it (both paths)', async () => {
    await service.log(dto);
    expect(injectedManager.create).toHaveBeenCalledWith(
      AuditLog,
      expect.objectContaining({ severity: AuditLogSeverity.INFO }),
    );

    const txManager = makeManagerMock();
    await service.log(dto, txManager);
    expect(txManager.create).toHaveBeenCalledWith(
      AuditLog,
      expect.objectContaining({ severity: AuditLogSeverity.INFO }),
    );
  });

  it('preserves an explicitly-supplied severity', async () => {
    await service.log({ ...dto, severity: AuditLogSeverity.CRITICAL });
    expect(injectedManager.create).toHaveBeenCalledWith(
      AuditLog,
      expect.objectContaining({ severity: AuditLogSeverity.CRITICAL }),
    );
  });
});
