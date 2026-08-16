import { mockCallArgument } from '@aquaculture/testing';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { AuditLogEntity } from '../audit-log.entity';
import { AuditLogService } from '../audit-log.service';
import { AuditMethod, AuditResult, AuditSeverity } from '../audit-log.tokens';

/**
 * AuditLogService — pin AUDITTRAIL-CRITICAL-004 mandatory-shape coverage
 * ============================================================================
 *
 * # Why this spec exists
 *
 * `AuditLogService.record()` (fire-and-forget) and `recordAwait()`
 * (synchronous) are the two write paths every domain handler funnels
 * through when emitting an audit row. Pre-extension both paths inlined a
 * literal `repository.create({ ... })` covering only the legacy 14-column
 * shape. The 8 mandatory-shape extension fields (AUDITTRAIL-CRITICAL-004)
 * silently dropped on both paths.
 *
 * After the extension, both paths route through `toEntityShape(dto)`. The
 * specs below pin:
 *
 *   1. Every legacy field still flows through unchanged (no regression).
 *   2. Every extension field flows through with the documented default
 *      semantics (undefined → null for optional fields, undefined →
 *      false for the boolean default `mfaVerified`).
 *   3. The two write paths (record / recordAwait) produce IDENTICAL row
 *      shapes for the same DTO — the legacy regression class.
 *   4. recordAwait propagates DB errors; record swallows + counts.
 */
describe('AuditLogService — mandatory-shape coverage (AUDITTRAIL-CRITICAL-004)', () => {
  let service: AuditLogService;
  let repo: jest.Mocked<Repository<AuditLogEntity>>;

  beforeEach(async () => {
    repo = {
      create: jest.fn((dto: unknown) => dto),
      save: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<Repository<AuditLogEntity>>;

    const moduleRef = await Test.createTestingModule({
      providers: [AuditLogService, { provide: getRepositoryToken(AuditLogEntity), useValue: repo }],
    }).compile();

    service = moduleRef.get(AuditLogService);
  });

  function lastSavedEntity(): Partial<AuditLogEntity> {
    expect(repo.save).toHaveBeenCalledTimes(1);
    return mockCallArgument<Partial<AuditLogEntity>>(repo.save);
  }

  describe('record() — fire-and-forget', () => {
    it('persists every legacy V1 field exactly as the DTO supplied it', async () => {
      service.record({
        action: 'CREATE',
        resource: 'Farm',
        resourceId: 'farm-1',
        userId: 'user-1',
        userEmail: 'a@b.com',
        tenantId: 'tenant-1',
        schemaName: 'tenant_abc',
        metadata: { foo: 'bar' },
        ip: '10.0.0.1',
        userAgent: 'curl/7.0',
        severity: AuditSeverity.WARNING,
        correlationId: 'corr-1',
      });

      // Defer microtask so the fire-and-forget save() has a chance to flush
      await Promise.resolve();

      const e = lastSavedEntity();
      expect(e).toMatchObject({
        action: 'CREATE',
        resource: 'Farm',
        resourceId: 'farm-1',
        userId: 'user-1',
        userEmail: 'a@b.com',
        tenantId: 'tenant-1',
        schemaName: 'tenant_abc',
        metadata: { foo: 'bar' },
        ip: '10.0.0.1',
        userAgent: 'curl/7.0',
        severity: AuditSeverity.WARNING,
        correlationId: 'corr-1',
      });
    });

    it('defaults severity to INFO when omitted', async () => {
      service.record({ action: 'X', resource: 'Y' });
      await Promise.resolve();
      expect(lastSavedEntity().severity).toBe(AuditSeverity.INFO);
    });
  });

  describe('record() / recordAwait() — extension-field plumbing', () => {
    const baseDto = { action: 'X', resource: 'Y' };

    it.each([
      ['actorHomeTenantId', 'tenant-actor', null],
      ['actedOnTenantId', 'tenant-target', null],
      ['method', AuditMethod.GRAPHQL, null],
      ['result', AuditResult.DENIED, null],
      ['preStateHash', 'a'.repeat(64), null],
      ['postStateHash', 'b'.repeat(64), null],
      ['justification', 'override per ticket #42', null],
      ['relatedAuditIds', ['00000000-0000-0000-0000-000000000001'], null],
    ] as const)(
      'record() carries %s through to the persisted entity',
      async (field, value, defaultWhenOmitted) => {
        service.record({ ...baseDto, [field]: value });
        await Promise.resolve();
        expect(lastSavedEntity()).toMatchObject({ [field]: value });

        // Reset for the omission case
        repo.save.mockClear();
        service.record({ ...baseDto });
        await Promise.resolve();
        expect(lastSavedEntity()).toMatchObject({
          [field]: defaultWhenOmitted,
        });
      },
    );

    it('mfaVerified defaults to false when omitted', async () => {
      service.record(baseDto);
      await Promise.resolve();
      expect(lastSavedEntity().mfaVerified).toBe(false);
    });

    it('mfaVerified=true is preserved (SOC 2 CC6.1 evidence path)', async () => {
      service.record({ ...baseDto, mfaVerified: true });
      await Promise.resolve();
      expect(lastSavedEntity().mfaVerified).toBe(true);
    });

    it('record() and recordAwait() produce IDENTICAL row shapes for the same DTO', async () => {
      const dto = {
        action: 'X',
        resource: 'Y',
        actorHomeTenantId: 'tenant-actor',
        actedOnTenantId: 'tenant-target',
        method: AuditMethod.NATS,
        mfaVerified: true,
        result: AuditResult.SUCCESS,
        preStateHash: 'a'.repeat(64),
        postStateHash: 'b'.repeat(64),
        justification: 'because',
        relatedAuditIds: ['11111111-1111-1111-1111-111111111111'],
      };

      service.record(dto);
      await Promise.resolve();
      const recordShape = lastSavedEntity();

      repo.save.mockClear();
      await service.recordAwait(dto);
      const awaitShape = lastSavedEntity();

      // Drop any TypeORM-injected fields (none expected via the mock) and
      // diff. The two paths must materialize the same set of column writes.
      expect(awaitShape).toEqual(recordShape);
    });
  });

  describe('recordAwait() — failure propagation', () => {
    it('propagates DB errors to the caller (fail-closed audit gate)', async () => {
      repo.save.mockRejectedValueOnce(new Error('connection refused'));
      await expect(service.recordAwait({ action: 'X', resource: 'Y' })).rejects.toThrow(
        'connection refused',
      );
    });

    it('increments failureCount on every silent record() failure', async () => {
      repo.save.mockRejectedValue(new Error('offline'));
      service.record({ action: 'X', resource: 'Y' });
      service.record({ action: 'X', resource: 'Y' });
      // Two unhandled rejections — flush microtasks
      await Promise.resolve();
      await Promise.resolve();
      expect(service.getFailureCount()).toBeGreaterThanOrEqual(2);
    });
  });

  describe('graceful degradation when repository unavailable', () => {
    let unboundService: AuditLogService;

    beforeEach(() => {
      // Construct without the repo to model the @Optional() injection
      // path (consumers that don't import AuditLogModule).
      unboundService = new AuditLogService();
    });

    it('record() is a no-op (silent debug log) when no repo is bound', () => {
      expect(() => unboundService.record({ action: 'X', resource: 'Y' })).not.toThrow();
    });

    it('recordAwait() resolves to undefined when no repo is bound', async () => {
      await expect(
        unboundService.recordAwait({ action: 'X', resource: 'Y' }),
      ).resolves.toBeUndefined();
    });
  });
});
