import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

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
 *   2. `log(dto)` (manager omitted) runs a SYSTEM-CONTEXT transaction whose
 *      FIRST statement is `set_config('app.bypass_rls','on', true)` —
 *      ORPHAN-HIGH-308 completion: TypeORM save() emits INSERT … RETURNING
 *      and PostgreSQL applies the SELECT policy to RETURNING rows, so a
 *      pre-auth/SUPER_ADMIN session (no tenant GUC) failed even after the
 *      audit_append_system INSERT policy landed.
 *   3. The default-severity behaviour (undefined → INFO) is preserved on both
 *      paths.
 */
type ManagerMock = { create: jest.Mock; save: jest.Mock; query: jest.Mock };

const makeManagerMock = (): ManagerMock => ({
  create: jest.fn((_target: unknown, shape: unknown) => shape),
  save: jest.fn((entity: unknown) => Promise.resolve(entity)),
  query: jest.fn(() => Promise.resolve([])),
});

describe('AuditLogService.log — manager-aware overload (FINDING #5)', () => {
  let service: AuditLogService;
  let injectedManager: ManagerMock;
  let txnManager: ManagerMock;
  let txnStatements: string[];

  const dto = {
    tenantId: 'tenant-1',
    performedBy: 'user-1',
    action: 'USER_ROLE_CHANGED',
    entityType: 'UserRoleAssignment',
  };

  beforeEach(async () => {
    // The repository's OWN manager (must never be used for writes anymore).
    injectedManager = makeManagerMock();
    // The system-context transaction manager the standalone path runs on.
    txnStatements = [];
    txnManager = makeManagerMock();
    txnManager.query.mockImplementation((sql: string) => {
      txnStatements.push(sql);
      return Promise.resolve([]);
    });
    txnManager.save.mockImplementation((entity: unknown) => {
      txnStatements.push('save');
      return Promise.resolve(entity);
    });

    const moduleRef = await Test.createTestingModule({
      providers: [
        AuditLogService,
        // useValue is untyped (DI any) — a structural { manager } double is
        // enough; the service only reaches auditLogRepository.manager.
        { provide: getRepositoryToken(AuditLog), useValue: { manager: injectedManager } },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        {
          provide: DataSource,
          useValue: {
            transaction: jest.fn(
              (cb: (m: ManagerMock) => Promise<unknown>): Promise<unknown> => cb(txnManager),
            ),
          },
        },
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

  it('ORPHAN-HIGH-308: standalone writes run a SYSTEM-CONTEXT transaction — bypass set_config BEFORE the save', async () => {
    await service.log(dto);

    // The write happens on the transaction manager, in the right order:
    // set_config first, then the save (whose RETURNING now passes RLS).
    expect(txnStatements[0]).toContain("set_config('app.bypass_rls', 'on', true)");
    expect(txnStatements).toContain('save');
    expect(txnManager.create).toHaveBeenCalledWith(
      AuditLog,
      expect.objectContaining({ action: dto.action }),
    );
    // The injected repository manager must never write (no un-scoped path).
    expect(injectedManager.create).not.toHaveBeenCalled();
    expect(injectedManager.save).not.toHaveBeenCalled();
  });

  it('defaults severity to INFO when the DTO omits it (both paths)', async () => {
    await service.log(dto);
    expect(txnManager.create).toHaveBeenCalledWith(
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
    expect(txnManager.create).toHaveBeenCalledWith(
      AuditLog,
      expect.objectContaining({ severity: AuditLogSeverity.CRITICAL }),
    );
  });
});
