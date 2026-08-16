import type { EntityManager, Repository } from 'typeorm';

import { AuditLog } from '../audit.entity';
import { AuditLogService } from '../audit.service';

describe('AuditLogService typed write policy', () => {
  let repository: { create: jest.Mock; manager: { query: jest.Mock } };
  let service: AuditLogService;

  beforeEach(() => {
    repository = {
      create: jest.fn((value: unknown) => value),
      manager: {
        query: jest.fn().mockImplementation((_sql: string, parameters: unknown[]) =>
          Promise.resolve([
            {
              id: 'audit-1',
              action: parameters[0],
              trustClass: 'AUTHORITATIVE_RUNTIME',
              provenance: null,
            },
          ]),
        ),
      },
    };
    service = new AuditLogService(repository as unknown as Repository<AuditLog>);
  });

  it('surfaces persistence failure before sensitive disclosure', async () => {
    const failure = new Error('audit database unavailable');
    repository.manager.query.mockRejectedValueOnce(failure);

    await expect(
      service.appendBeforeDisclosure({
        action: 'AUDIT_LOG_ACCESSED',
        entityType: 'AuditLog',
        performedBy: '11111111-1111-4111-8111-111111111111',
      }),
    ).rejects.toBe(failure);
  });

  it('uses the caller transaction repository for a required append', async () => {
    const transactionRepository = {
      create: jest.fn((value: unknown) => value),
      manager: {
        query: jest.fn().mockImplementation((_sql: string, parameters: unknown[]) =>
          Promise.resolve([
            {
              id: 'audit-1',
              action: parameters[0],
              trustClass: 'AUTHORITATIVE_RUNTIME',
              provenance: null,
            },
          ]),
        ),
      },
    };
    const entityManager = {
      withRepository: jest.fn().mockReturnValue(transactionRepository),
    };

    await expect(
      service.appendInTransaction(entityManager as unknown as EntityManager, {
        action: 'IMPERSONATION_STARTED',
        entityType: 'ImpersonationSession',
        entityId: '11111111-1111-4111-8111-111111111111',
        sessionId: '11111111-1111-4111-8111-111111111111',
        performedBy: '22222222-2222-4222-8222-222222222222',
      }),
    ).resolves.toMatchObject({ id: 'audit-1' });

    expect(entityManager.withRepository).toHaveBeenCalledWith(repository);
    expect(transactionRepository.manager.query).toHaveBeenCalledWith(
      expect.stringContaining('admin.append_authoritative_audit_v1'),
      expect.arrayContaining(['IMPERSONATION_STARTED']),
    );
    expect(repository.manager.query).not.toHaveBeenCalled();
  });

  it('restricts best-effort null semantics to optional telemetry', async () => {
    repository.manager.query.mockRejectedValueOnce(new Error('audit database unavailable'));

    await expect(
      service.appendOptionalTelemetry({
        action: 'ADMIN_OPERATION_TELEMETRY',
        entityType: 'Telemetry',
        performedBy: 'system',
      }),
    ).resolves.toBeNull();
  });

  it('rejects a receipt that attempts to elevate non-authoritative evidence', async () => {
    repository.manager.query.mockResolvedValueOnce([
      {
        id: 'audit-legacy',
        action: 'AUDIT_LOG_ACCESSED',
        trustClass: 'LEGACY_UNVERIFIED',
        provenance: { sourceRowId: 'legacy-row' },
      },
    ]);

    await expect(
      service.appendBeforeDisclosure({
        action: 'AUDIT_LOG_ACCESSED',
        entityType: 'AuditLog',
        performedBy: '11111111-1111-4111-8111-111111111111',
      }),
    ).rejects.toThrow('invalid receipt');
  });

  it('rejects a policy mismatch even when an untyped runtime caller bypasses TypeScript', async () => {
    await expect(
      service.appendBeforeDisclosure({
        action: 'IMPERSONATION_STARTED',
        entityType: 'ImpersonationSession',
        performedBy: '11111111-1111-4111-8111-111111111111',
      } as never),
    ).rejects.toThrow('requires MANDATORY_IN_TRANSACTION');

    expect(repository.manager.query).not.toHaveBeenCalled();
  });
});
