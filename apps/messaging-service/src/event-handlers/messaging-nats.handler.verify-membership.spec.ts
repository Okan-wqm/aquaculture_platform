import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { Test } from '@nestjs/testing';

import { ChannelMember, ChannelMemberRole } from '../channel/entities/channel-member.entity';
import { AttachmentObjectPurgeService } from '../compliance/services/attachment-object-purge.service';
import { LegalHoldService } from '../compliance/services/legal-hold.service';
import { Message } from '../message/entities/message.entity';
import { MediaService } from '../message/services/media.service';
import { PartitionManagerService } from '../partition/partition-manager.service';
import { REDIS_CLIENT } from '../shared/redis.provider';
import { MessagingNatsHandler } from './messaging-nats.handler';

/**
 * MSGFIX-FAZ1 — verifyMembership tenant scoping + the NATS-path RLS binding.
 *
 * Live evidence (2026-09-16, DEPLOY-FAZ1.md §3): user 8025339a…, the ACTIVE
 * OWNER of channel ddf8e5ca… in tenant_7f6b08ab90e246d3.channel_members, was
 * denied a WS room join three times ("denied join — not a member"). Root
 * cause: withTenantQueryRunner set ONLY search_path — under FORCE RLS +
 * tenant_isolation_policy the membership row is invisible unless
 * app.current_tenant is set (proven by a controlled SET ROLE experiment:
 * search_path-only → 0 rows; GUC set → 1 row). These specs pin both layers
 * of the cure: the RLS GUC binding and the explicit tenantId predicate.
 */
describe('MessagingNatsHandler.verifyMembership', () => {
  const tenantId = '11111111-1111-4111-8111-111111111111';
  const otherTenantId = '99999999-9999-4999-8999-999999999999';
  const channelId = '22222222-2222-4222-8222-222222222222';
  const userId = '44444444-4444-4444-4444-444444444444';

  let handler: MessagingNatsHandler;
  let query: jest.Mock;
  /** Ordered trace of transaction plumbing (search_path, RLS GUC, commit). */
  let ops: string[];

  beforeEach(() => {
    ops = [];
  });

  /**
   * Build the handler. `primeFindOne` MUST be set before the call — the
   * stub queryRunner captures the mock by value (no re-stubbing after).
   * The GUC read-back simulates a functioning connection (echoes what
   * set_config was asked for); `readbackOverride` injects a mismatch for
   * the fail-closed test.
   */
  async function buildHandler(options: {
    primeFindOne: jest.Mock;
    readbackOverride?: { tenant: string | null; bypass: string | null };
  }): Promise<MessagingNatsHandler> {
    const { primeFindOne, readbackOverride } = options;
    let isTransactionActive = false;
    /** GUC state as a healthy connection would resolve it. */
    const guc: Record<string, string | null> = {};
    const queryMock = jest.fn((sql: string, params: unknown[] = []) => {
      if (sql.includes('search_path')) {
        ops.push('search_path');
        return Promise.resolve(undefined);
      }
      // bindTenantRlsContext writes the bypass GUC with an in-SQL literal:
      // SELECT set_config($1, 'off', true)
      if (sql.includes("set_config($1, 'off', true)")) {
        ops.push(`set_config:${String(params[0])}=off`);
        guc[String(params[0])] = 'off';
        return Promise.resolve(undefined);
      }
      if (sql.includes('set_config')) {
        ops.push(`set_config:${String(params[0])}=${String(params[1])}`);
        guc[String(params[0])] = String(params[1]);
        return Promise.resolve(undefined);
      }
      if (sql.includes('current_setting')) {
        // bindTenantRlsContext read-back: what the connection ACTUALLY got.
        ops.push('guc_readback');
        return Promise.resolve([
          readbackOverride ?? {
            tenant: guc['app.current_tenant'] ?? null,
            bypass: guc['app.bypass_rls'] ?? 'off',
          },
        ]);
      }
      return Promise.resolve(undefined);
    });

    const queryRunner = {
      connect: jest.fn().mockResolvedValue(undefined),
      startTransaction: jest.fn().mockImplementation(() => {
        isTransactionActive = true;
        ops.push('begin');
        return Promise.resolve();
      }),
      commitTransaction: jest.fn().mockImplementation(() => {
        isTransactionActive = false;
        ops.push('commit');
        return Promise.resolve();
      }),
      rollbackTransaction: jest.fn().mockImplementation(() => {
        isTransactionActive = false;
        ops.push('rollback');
        return Promise.resolve();
      }),
      get isTransactionActive(): boolean {
        return isTransactionActive;
      },
      query: queryMock,
      release: jest.fn().mockResolvedValue(undefined),
      manager: { findOne: primeFindOne },
    };
    const dataSource = { createQueryRunner: () => queryRunner };

    const moduleRef = await Test.createTestingModule({
      providers: [
        MessagingNatsHandler,
        { provide: getRepositoryToken(ChannelMember), useValue: {} },
        { provide: getRepositoryToken(Message), useValue: {} },
        { provide: getDataSourceToken(), useValue: dataSource },
        { provide: PartitionManagerService, useValue: {} },
        { provide: LegalHoldService, useValue: {} },
        { provide: MediaService, useValue: {} },
        { provide: REDIS_CLIENT, useValue: {} },
        { provide: AttachmentObjectPurgeService, useValue: { purgeObjects: jest.fn() } },
      ],
    }).compile();

    query = queryMock;
    return moduleRef.get(MessagingNatsHandler);
  }

  /** The RLS-visible table: only the row bound to `tenantId` exists. */
  function tenantScopedFindOne(): jest.Mock {
    return jest.fn((_entity: unknown, opts: { where: Record<string, unknown> }) =>
      Promise.resolve(
        opts.where['tenantId'] === tenantId
          ? ({
              tenantId,
              channelId,
              userId,
              leftAt: null,
              role: ChannelMemberRole.OWNER,
            } as Partial<ChannelMember>)
          : null,
      ),
    );
  }

  it('returns true for an active member and scopes the lookup by tenantId', async () => {
    const findOne = tenantScopedFindOne();
    handler = await buildHandler({ primeFindOne: findOne });

    const result = await handler.verifyMembership({ channelId, userId, tenantId });

    expect(result).toBe(true);
    // The explicit tenantId predicate (GraphQL-side pattern,
    // message.resolver.ts validateChannelMembership).
    const where = findOne.mock.calls[0]![1]!.where as Record<string, unknown>;
    expect(where).toMatchObject({ tenantId, channelId, userId });
  });

  it('returns NOT-a-member for a foreign tenant claiming the same channel id', async () => {
    // Same channel id, same user id, DIFFERENT tenant: only a row bound to
    // the requesting tenant may match. The predicate is what makes the
    // lookup miss instead of leaking another tenant's membership.
    const findOne = tenantScopedFindOne();
    handler = await buildHandler({ primeFindOne: findOne });

    const result = await handler.verifyMembership({ channelId, userId, tenantId: otherTenantId });

    expect(result).toBe(false);
    const where = findOne.mock.calls[0]![1]!.where as Record<string, unknown>;
    expect(where['tenantId']).toBe(otherTenantId);
  });

  it('returns false when the tenant has no active membership row', async () => {
    const findOne = jest.fn().mockResolvedValue(null);
    handler = await buildHandler({ primeFindOne: findOne });

    const result = await handler.verifyMembership({ channelId, userId, tenantId });

    expect(result).toBe(false);
  });

  it('binds app.current_tenant (RLS GUC) before the membership read — the MSGFIX-FAZ1 root cause', async () => {
    const findOne = jest.fn().mockResolvedValue(null);
    handler = await buildHandler({ primeFindOne: findOne });

    await handler.verifyMembership({ channelId, userId, tenantId });

    // The GUC the live RLS policy requires (tenant_isolation_policy:
    // "tenantId" = app.current_tenant), bound transaction-locally...
    expect(query).toHaveBeenCalledWith('SELECT set_config($1, $2, true)', [
      'app.current_tenant',
      tenantId,
    ]);
    // ...a stale bypass from a pooled session is forced OFF (the bypass
    // value is an in-SQL literal, not a bind parameter)...
    expect(query).toHaveBeenCalledWith("SELECT set_config($1, 'off', true)", ['app.bypass_rls']);
    // ...and both land BEFORE the work runs (search_path → GUC bind →
    // GUC read-back → membership lookup → commit).
    expect(ops.indexOf(`set_config:app.current_tenant=${tenantId}`)).toBeGreaterThan(
      ops.indexOf('search_path'),
    );
    expect(ops.indexOf('guc_readback')).toBeGreaterThan(
      ops.indexOf(`set_config:app.current_tenant=${tenantId}`),
    );
    expect(ops.indexOf('commit')).toBeGreaterThan(ops.indexOf('guc_readback'));
  });

  it('fails closed when the RLS read-back does not match the requested tenant', async () => {
    // bindTenantRlsContext read-back contract: a GUC that did not take
    // effect must surface as an error, never as a silent 0-row read
    // (the exact failure mode that caused the live false-deny).
    const findOne = jest.fn().mockResolvedValue(null);
    handler = await buildHandler({
      primeFindOne: findOne,
      readbackOverride: { tenant: otherTenantId, bypass: 'off' },
    });

    await expect(handler.verifyMembership({ channelId, userId, tenantId })).rejects.toThrow();

    expect(findOne).not.toHaveBeenCalled();
    expect(ops).toContain('rollback');
    expect(ops).not.toContain('commit');
  });
});
