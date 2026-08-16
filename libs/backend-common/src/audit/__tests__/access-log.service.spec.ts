import { mockCallArgument } from '@aquaculture/testing';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { AccessLogEntity } from '../access-log.entity';
import { AccessLogService } from '../access-log.service';

/**
 * AccessLogService — pin every persistence-shape rule (AUDITTRAIL-HIGH-004)
 * ============================================================================
 *
 * # Why this spec exists
 *
 * AccessLogService.record() is the single entry point for the
 * low-level HTTP access stream. A regression that drops a field
 * (e.g. forgets to map dto.userAgent) would silently empty out
 * forensic columns until an investigator notices months later.
 * Pinning the dto-to-entity shape closes that drift class at unit-
 * test time.
 *
 * Specs cover:
 *
 *   - Every DTO field flows through to the entity unchanged
 *     (per-field round-trip).
 *   - Optional fields default to null (not undefined → important
 *     because TypeORM's `repository.create({ ...undefined })`
 *     would persist DEFAULT instead of NULL on some drivers).
 *   - The fire-and-forget shape: record() returns void, not Promise.
 *     Awaiting it must be a type error in real consumers (the
 *     middleware deliberately doesn't await — see access-log.
 *     middleware class docstring).
 *   - getFailureCount increments on persistence failure.
 *   - Service is a no-op + debug log when no repository is bound
 *     (matches the @Optional() injection pattern in
 *     AuditLogService).
 */
describe('AccessLogService — persistence-shape coverage (AUDITTRAIL-HIGH-004)', () => {
  let service: AccessLogService;
  let repo: jest.Mocked<Repository<AccessLogEntity>>;

  beforeEach(async () => {
    repo = {
      create: jest.fn((dto: unknown) => dto),
      save: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<Repository<AccessLogEntity>>;

    const moduleRef = await Test.createTestingModule({
      providers: [
        AccessLogService,
        { provide: getRepositoryToken(AccessLogEntity), useValue: repo },
      ],
    }).compile();

    service = moduleRef.get(AccessLogService);
  });

  function lastSavedEntity(): Partial<AccessLogEntity> {
    expect(repo.save).toHaveBeenCalledTimes(1);
    return mockCallArgument<Partial<AccessLogEntity>>(repo.save);
  }

  describe('record() — full DTO round-trip', () => {
    it('persists every required field exactly as supplied', async () => {
      service.record({
        method: 'GET',
        path: '/api/v1/farms/123',
        status: 200,
        durationMs: 47,
        userId: 'user-1',
        tenantId: '11111111-1111-1111-1111-111111111111',
        correlationId: 'corr-1',
        ip: '203.0.113.1',
        userAgent: 'Mozilla/5.0',
      });

      // Fire-and-forget; flush microtasks
      await Promise.resolve();

      expect(lastSavedEntity()).toMatchObject({
        method: 'GET',
        path: '/api/v1/farms/123',
        status: 200,
        durationMs: 47,
        userId: 'user-1',
        tenantId: '11111111-1111-1111-1111-111111111111',
        correlationId: 'corr-1',
        ip: '203.0.113.1',
        userAgent: 'Mozilla/5.0',
      });
    });

    it('defaults every optional field to null when omitted', async () => {
      service.record({
        method: 'POST',
        path: '/health',
        status: 503,
        durationMs: 0,
      });
      await Promise.resolve();

      expect(lastSavedEntity()).toMatchObject({
        method: 'POST',
        path: '/health',
        status: 503,
        durationMs: 0,
        userId: null,
        tenantId: null,
        correlationId: null,
        ip: null,
        userAgent: null,
      });
    });

    it('returns void synchronously (fire-and-forget contract)', () => {
      const result = service.record({
        method: 'GET',
        path: '/x',
        status: 200,
        durationMs: 1,
      });
      expect(result).toBeUndefined();
    });
  });

  describe('persistence failure handling', () => {
    it('increments failureCount when save() rejects', async () => {
      repo.save.mockRejectedValue(new Error('connection refused'));
      service.record({ method: 'GET', path: '/x', status: 200, durationMs: 1 });
      service.record({ method: 'GET', path: '/y', status: 200, durationMs: 1 });
      // Two unhandled rejections — flush microtasks twice
      await Promise.resolve();
      await Promise.resolve();
      expect(service.getFailureCount()).toBeGreaterThanOrEqual(2);
    });

    it('does not throw on persistence failure (fire-and-forget contract)', () => {
      repo.save.mockRejectedValue(new Error('boom'));
      expect(() =>
        service.record({
          method: 'GET',
          path: '/x',
          status: 200,
          durationMs: 1,
        }),
      ).not.toThrow();
    });
  });

  describe('graceful degradation when repository unavailable', () => {
    it('record() is a no-op (silent debug log) when no repo is bound', () => {
      const unboundService = new AccessLogService();
      expect(() =>
        unboundService.record({
          method: 'GET',
          path: '/x',
          status: 200,
          durationMs: 1,
        }),
      ).not.toThrow();
    });

    it('getFailureCount() is 0 when no repo is bound', () => {
      const unboundService = new AccessLogService();
      unboundService.record({
        method: 'GET',
        path: '/x',
        status: 200,
        durationMs: 1,
      });
      expect(unboundService.getFailureCount()).toBe(0);
    });
  });
});
