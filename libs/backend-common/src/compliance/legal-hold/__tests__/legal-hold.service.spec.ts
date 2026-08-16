/**
 * Unit tests for LegalHoldService — canonical registry behaviour.
 *
 * Tests cover:
 *   - assertNoHold throws LegalHoldActiveError when blocked
 *   - isUnderHold cache hit / cache miss / DB fallback
 *   - activate rejects missing legalMatterId (GDPR proportionality)
 *   - release rejects already-released holds (write-once-released)
 *   - cache invalidation on activate + release
 *
 * Closes: docs/reviews/legal-hold-auditor/2026-04-28-core-platform-review.md#LEGAL-CRITICAL-001 (foundation)
 */

import { defined, mockCallArgument } from '@aquaculture/testing';
import { ForbiddenException } from '@nestjs/common';

import { LegalHoldEntity } from '../legal-hold.entity';
import { LegalHoldService, LegalHoldCacheClient } from '../legal-hold.service';
import { LegalHoldActiveError } from '../legal-hold.types';

const TENANT = '11111111-1111-4111-8111-111111111111';
const RESOURCE = '22222222-2222-4222-8222-222222222222';
const MATTER = 'matter-2026-Q1-001';
const ADMIN = '33333333-3333-4333-8333-333333333333';

function makeRow(overrides: Partial<LegalHoldEntity> = {}): LegalHoldEntity {
  return {
    id: '44444444-4444-4444-8444-444444444444',
    tenantId: TENANT,
    scope: 'tenant',
    resourceId: null,
    reason: 'pending litigation',
    legalMatterId: MATTER,
    appliedBy: ADMIN,
    appliedAt: new Date('2026-04-28T10:00:00.000Z'),
    releasedBy: null,
    releasedAt: null,
    releaseReason: null,
    ...overrides,
  };
}

interface MockLegalHoldRepository {
  readonly find: jest.Mock<Promise<LegalHoldEntity[]>, [options?: unknown]>;
  readonly findOne: jest.Mock<Promise<LegalHoldEntity | null>, [options?: unknown]>;
  readonly save: jest.Mock<Promise<LegalHoldEntity>, [entity: LegalHoldEntity]>;
  readonly create: jest.Mock<LegalHoldEntity, [row: LegalHoldEntity]>;
}

function makeMockRepo(): MockLegalHoldRepository {
  return {
    find: jest.fn<Promise<LegalHoldEntity[]>, [options?: unknown]>(),
    findOne: jest.fn<Promise<LegalHoldEntity | null>, [options?: unknown]>(),
    save: jest.fn<Promise<LegalHoldEntity>, [entity: LegalHoldEntity]>(),
    create: jest.fn<LegalHoldEntity, [row: LegalHoldEntity]>((row) => row),
  };
}

function makeMockCache(): jest.Mocked<LegalHoldCacheClient> {
  return {
    get: jest.fn(),
    setex: jest.fn(),
    del: jest.fn(),
  };
}

describe('LegalHoldService', () => {
  describe('isUnderHold', () => {
    it('returns true when DB row exists and cache is absent', async () => {
      const repo = makeMockRepo();
      repo.findOne.mockResolvedValue(makeRow());
      const svc = new LegalHoldService(repo as never);
      expect(await svc.isUnderHold(TENANT, 'tenant')).toBe(true);
    });

    it('returns false when no DB row matches', async () => {
      const repo = makeMockRepo();
      repo.findOne.mockResolvedValue(null);
      const svc = new LegalHoldService(repo as never);
      expect(await svc.isUnderHold(TENANT, 'tenant')).toBe(false);
    });

    it('honours cache hit "1" without DB fallback', async () => {
      const repo = makeMockRepo();
      const cache = makeMockCache();
      cache.get.mockResolvedValue('1');
      const svc = new LegalHoldService(repo as never, cache);
      expect(await svc.isUnderHold(TENANT, 'tenant')).toBe(true);
      expect(repo.findOne).not.toHaveBeenCalled();
    });

    it('honours cache hit "0" without DB fallback', async () => {
      const repo = makeMockRepo();
      const cache = makeMockCache();
      cache.get.mockResolvedValue('0');
      const svc = new LegalHoldService(repo as never, cache);
      expect(await svc.isUnderHold(TENANT, 'tenant')).toBe(false);
      expect(repo.findOne).not.toHaveBeenCalled();
    });

    it('falls back to DB on cache miss and writes through', async () => {
      const repo = makeMockRepo();
      const cache = makeMockCache();
      cache.get.mockResolvedValue(null);
      repo.findOne.mockResolvedValue(makeRow());
      const svc = new LegalHoldService(repo as never, cache);
      expect(await svc.isUnderHold(TENANT, 'tenant')).toBe(true);
      expect(cache.setex).toHaveBeenCalledWith(expect.any(String), 300, '1');
    });
  });

  describe('assertNoHold', () => {
    it('throws LegalHoldActiveError with full context on block', async () => {
      const repo = makeMockRepo();
      const blockingRow = makeRow({
        scope: 'farm',
        resourceId: RESOURCE,
        legalMatterId: 'matter-X-2026',
      });
      repo.findOne.mockResolvedValue(blockingRow);
      const svc = new LegalHoldService(repo as never);
      try {
        await svc.assertNoHold(TENANT, 'farm', RESOURCE);
        throw new Error('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(LegalHoldActiveError);
        if (!(e instanceof LegalHoldActiveError)) {
          throw e;
        }
        expect(e.tenantId).toBe(TENANT);
        expect(e.scope).toBe('farm');
        expect(e.resourceId).toBe(RESOURCE);
        expect(e.legalMatterId).toBe('matter-X-2026');
      }
    });

    it('returns silently when no hold is active', async () => {
      const repo = makeMockRepo();
      repo.findOne.mockResolvedValue(null);
      const svc = new LegalHoldService(repo as never);
      await expect(svc.assertNoHold(TENANT, 'tenant')).resolves.toBeUndefined();
    });
  });

  describe('activate', () => {
    it('rejects missing legalMatterId with ForbiddenException (GDPR proportionality)', async () => {
      const repo = makeMockRepo();
      const svc = new LegalHoldService(repo as never);
      await expect(
        svc.activate({
          tenantId: TENANT,
          scope: 'tenant',
          reason: 'pending',
          legalMatterId: '',
          appliedBy: ADMIN,
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('persists row + invalidates cache + returns LegalHoldRecord', async () => {
      const repo = makeMockRepo();
      const cache = makeMockCache();
      const saved = makeRow();
      repo.save.mockResolvedValue(saved);
      const svc = new LegalHoldService(repo as never, cache);
      const result = await svc.activate({
        tenantId: TENANT,
        scope: 'tenant',
        reason: 'pending',
        legalMatterId: MATTER,
        appliedBy: ADMIN,
      });
      expect(repo.save).toHaveBeenCalled();
      expect(cache.del).toHaveBeenCalled();
      expect(result.id).toBe(saved.id);
      expect(result.legalMatterId).toBe(MATTER);
      expect(result.appliedAtIso).toBe(saved.appliedAt.toISOString());
    });
  });

  describe('release', () => {
    it('rejects when hold is already released (write-once-released)', async () => {
      const repo = makeMockRepo();
      repo.findOne.mockResolvedValue(makeRow({ releasedAt: new Date(), releasedBy: ADMIN }));
      const svc = new LegalHoldService(repo as never);
      await expect(
        svc.release({
          holdId: 'any',
          tenantId: TENANT,
          releasedBy: ADMIN,
          releaseReason: 'matter closed',
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('rejects when hold not found in tenant', async () => {
      const repo = makeMockRepo();
      repo.findOne.mockResolvedValue(null);
      const svc = new LegalHoldService(repo as never);
      await expect(
        svc.release({
          holdId: 'unknown',
          tenantId: TENANT,
          releasedBy: ADMIN,
          releaseReason: 'matter closed',
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('persists release fields + invalidates cache on success', async () => {
      const repo = makeMockRepo();
      const cache = makeMockCache();
      const initialRow = makeRow();
      const finalRow = makeRow({
        releasedBy: ADMIN,
        releasedAt: new Date('2026-05-01T00:00:00.000Z'),
        releaseReason: 'matter closed',
      });
      repo.findOne.mockResolvedValue(initialRow);
      repo.save.mockResolvedValue(finalRow);
      const svc = new LegalHoldService(repo as never, cache);
      const result = await svc.release({
        holdId: initialRow.id,
        tenantId: TENANT,
        releasedBy: ADMIN,
        releaseReason: 'matter closed',
      });
      expect(repo.save).toHaveBeenCalled();
      expect(cache.del).toHaveBeenCalled();
      expect(result.releasedBy).toBe(ADMIN);
      expect(result.releaseReason).toBe('matter closed');
      expect(result.releasedAtIso).toBe(
        defined(finalRow.releasedAt, 'Expected release timestamp').toISOString(),
      );
    });
  });

  describe('listActive', () => {
    it('returns active holds for the tenant in DESC appliedAt order', async () => {
      const repo = makeMockRepo();
      repo.find.mockResolvedValue([makeRow(), makeRow({ id: 'b' })]);
      const svc = new LegalHoldService(repo as never);
      const holds = await svc.listActive(TENANT);
      expect(holds.length).toBe(2);
      const findOptions = mockCallArgument<{
        where: { tenantId: string };
        order: { appliedAt: 'DESC' };
      }>(repo.find);
      expect(findOptions.where.tenantId).toBe(TENANT);
      expect(findOptions.order).toEqual({ appliedAt: 'DESC' });
    });
  });
});
