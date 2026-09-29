import { Logger, NotFoundException } from '@nestjs/common';
import {
  collaborator,
  createFakeTenantConnection,
  type FakeTenantConnection,
} from '@platform/testing';
import type { EntityMetadata, ObjectLiteral, Repository } from 'typeorm';

import { getRequestContext } from '../../logging/request-context';
import { RLS_TENANT_GUC } from '../../database/rls/apply-tenant-rls.helper';
import { TenantScope } from '../../database/tenant-scope';
import { getTenantSchemaName } from '../../database/tenant-schema.utils';
import {
  respondTenantBound,
  type TenantBoundResponderDeps,
  type TenantScopeOpener,
} from '../tenant-bound-reply';
import type { TenantOwnerRegistry } from '../tenant-owned-rows';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '99999999-9999-4999-8999-999999999999';
const TANK_ID = '22222222-2222-4222-8222-222222222222';
const SUBJECT = 'request.farm.ai.getTankCapacity';

class TankRow {}

interface TankRequest {
  tenantId: string;
  tankId: string;
}

const isTankRequest = (v: unknown): v is TankRequest =>
  typeof v === 'object' && v !== null && typeof (v as { tankId?: unknown }).tankId === 'string';

/** A tank repository double: `rows` are the tank ids that exist in the scope's tenant. */
function tankRepository(
  rows: readonly string[],
  withTenantColumn = true,
): Repository<ObjectLiteral> {
  const metadata = collaborator<EntityMetadata>(
    {
      findColumnWithPropertyName: jest.fn((name: string) =>
        name === 'id' || (name === 'tenantId' && withTenantColumn)
          ? collaborator<ReturnType<EntityMetadata['findColumnWithPropertyName']> & object>(
              {},
              'Column',
            )
          : undefined,
      ),
    },
    'EntityMetadata',
  );
  return collaborator<Repository<ObjectLiteral>>(
    {
      metadata,
      findOne: jest.fn(async (options: { where: Record<string, unknown> }) =>
        rows.includes(String(options.where['id'])) ? { id: options.where['id'] } : null,
      ),
    },
    'Repository',
  );
}

/**
 * The shared responder skeleton for every AI-facing subject (K10 /
 * MT-HIGH-062): it owns the tenant boundary, resolves owned ids inside it and
 * names the tenant read back from the serving connection.
 */
describe('respondTenantBound', () => {
  const logger = new Logger('spec');
  const owners: TenantOwnerRegistry = { tankId: { entity: TankRow } };
  let conn: FakeTenantConnection;
  let openScope: jest.Mock;
  let deps: TenantBoundResponderDeps;

  beforeEach(() => {
    jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    jest.spyOn(logger, 'error').mockImplementation(() => undefined);
    conn = createFakeTenantConnection();
    conn.manager.getRepository.mockReturnValue(tankRepository([TANK_ID]));
    const open: TenantScopeOpener = (tenantId, access, fn) =>
      access === 'read'
        ? TenantScope.read(conn.dataSource, 'farm', tenantId, fn)
        : TenantScope.write(conn.dataSource, 'farm', tenantId, fn);
    openScope = jest.fn(open);
    deps = { logger, openScope, owners };
  });

  afterEach(() => jest.restoreAllMocks());

  const ask = (
    payload: unknown,
    handle: (request: { tankId: string }, scope: TenantScope) => Promise<unknown>,
    access?: 'read' | 'write',
  ): ReturnType<typeof respondTenantBound<TankRequest, unknown>> =>
    respondTenantBound(
      deps,
      { subject: SUBJECT, isRequest: isTankRequest, handle, access },
      payload,
    );

  it('rejects a payload that fails the contract guard without opening the boundary', async () => {
    // SCENARIO: a request whose tenant is valid but whose fields fail the guard.
    // EXPECTS: INVALID_REQUEST naming that tenant; no boundary, no handler.
    const handle = jest.fn();
    const reply = await ask({ tenantId: TENANT_A }, handle);
    expect(reply).toEqual({ ok: false, tenantId: TENANT_A, error: 'INVALID_REQUEST' });
    expect(openScope).not.toHaveBeenCalled();
    expect(handle).not.toHaveBeenCalled();
  });

  it('names no tenant when the payload tenant is not a UUID, even if the guard passes', async () => {
    const reply = await ask({ tenantId: 't', tankId: TANK_ID }, jest.fn());
    expect(reply).toEqual({ ok: false, tenantId: null, error: 'INVALID_REQUEST' });
    expect(openScope).not.toHaveBeenCalled();
  });

  it('refuses a request with an id field that has no declared owner table', async () => {
    // SCENARIO: a new subject adds `systemId` but nobody declared which table owns it.
    // EXPECTS: INVALID_REQUEST before any read — an unresolved id could yield a default answer.
    const reply = await ask({ tenantId: TENANT_A, tankId: TANK_ID, systemId: TANK_ID }, jest.fn());
    expect(reply).toEqual({ ok: false, tenantId: TENANT_A, error: 'INVALID_REQUEST' });
    expect(openScope).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ undeclared: ['systemId'] }),
    );
  });

  it('hands the handler a tenant-free request and a genuine scope, and echoes the served tenant', async () => {
    // SCENARIO: a valid request for an owned tank.
    // EXPECTS: the handler sees no tenantId, reads through a scope pinned to A, in A's frame;
    //          the reply names A as read back from the connection.
    const reply = await ask({ tenantId: TENANT_A, tankId: TANK_ID }, async (request, scope) => ({
      keys: Object.keys(request),
      scopeTenant: scope.tenantId,
      genuine: TenantScope.isGenuine(scope),
      frame: getRequestContext().tenantId,
    }));
    expect(reply).toEqual({
      ok: true,
      tenantId: TENANT_A,
      data: { keys: ['tankId'], scopeTenant: TENANT_A, genuine: true, frame: TENANT_A },
    });
    expect(openScope).toHaveBeenCalledWith(TENANT_A, 'read', expect.any(Function));
  });

  it('answers NOT_FOUND for an id that is not a row of the tenant, before the handler runs', async () => {
    // SCENARIO: tenant A asks about tenant B's tank id.
    // EXPECTS: NOT_FOUND for A; the handler never computes an answer for the foreign id.
    const handle = jest.fn();
    const foreignTank = '33333333-3333-4333-8333-333333333333';
    const reply = await ask({ tenantId: TENANT_A, tankId: foreignTank }, handle);
    expect(reply).toEqual({ ok: false, tenantId: TENANT_A, error: 'NOT_FOUND' });
    expect(handle).not.toHaveBeenCalled();
  });

  it('pins the owner lookup to the scope tenant when the table carries tenantId', async () => {
    const repository = tankRepository([TANK_ID]);
    conn.manager.getRepository.mockReturnValue(repository);
    await ask({ tenantId: TENANT_A, tankId: TANK_ID }, async () => 'ok');
    expect(repository.findOne).toHaveBeenCalledWith({
      where: { id: TANK_ID, tenantId: TENANT_A },
      select: { id: true },
    });
  });

  it('turns a NotFoundException from the handler into NOT_FOUND for the served tenant', async () => {
    const reply = await ask({ tenantId: TENANT_A, tankId: TANK_ID }, () =>
      Promise.reject(new NotFoundException('Tank not found')),
    );
    expect(reply).toEqual({ ok: false, tenantId: TENANT_A, error: 'NOT_FOUND' });
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('withholds the data and names B when the handler moved the connection to tenant B', async () => {
    // SCENARIO: a handler switches search_path and the RLS tenant to B inside A's scope,
    //           then returns rows (the "stale pooled search_path" class, made deliberate).
    // EXPECTS: no data in the reply; the reply names B, so the consumer sees a tenant mismatch.
    const reply = await ask({ tenantId: TENANT_A, tankId: TANK_ID }, async () => {
      conn.state.searchPath = [getTenantSchemaName(TENANT_B), 'farm'];
      conn.state.settings.set(RLS_TENANT_GUC, TENANT_B);
      return { secret: 'tenant B rows' };
    });
    expect(reply).toEqual({ ok: false, tenantId: TENANT_B, error: 'INTERNAL_ERROR' });
    expect(JSON.stringify(reply)).not.toContain('tenant B rows');
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ requestedTenantId: TENANT_A, servedTenantId: TENANT_B }),
    );
  });

  it('names no tenant when the connection no longer serves one consistently', async () => {
    // SCENARIO: only the search_path moved to B; the RLS tenant still says A.
    // EXPECTS: tenantId null — the consumer treats it as a mismatch, and no data is sent.
    const reply = await ask({ tenantId: TENANT_A, tankId: TANK_ID }, async () => {
      conn.state.searchPath = [getTenantSchemaName(TENANT_B), 'farm'];
      return { rows: 1 };
    });
    expect(reply).toEqual({ ok: false, tenantId: null, error: 'INTERNAL_ERROR' });
  });

  it('rolls a write back when the connection served another tenant', async () => {
    // SCENARIO: the one write subject (createTask) ends on a connection moved to B.
    // EXPECTS: the transaction is rolled back, never committed.
    const reply = await ask(
      { tenantId: TENANT_A, tankId: TANK_ID },
      async () => {
        conn.state.settings.set(RLS_TENANT_GUC, TENANT_B);
        return { created: true };
      },
      'write',
    );
    expect(reply).toEqual({ ok: false, tenantId: null, error: 'INTERNAL_ERROR' });
    expect(conn.queryRunner.rollbackTransaction).toHaveBeenCalled();
    expect(conn.queryRunner.commitTransaction).not.toHaveBeenCalled();
  });

  it('turns any other failure into INTERNAL_ERROR and logs it structurally — never throws', async () => {
    const reply = await ask({ tenantId: TENANT_A, tankId: TANK_ID }, () =>
      Promise.reject(new Error('db down')),
    );
    expect(reply).toEqual({ ok: false, tenantId: TENANT_A, error: 'INTERNAL_ERROR' });
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ subject: SUBJECT, error: 'db down' }),
    );
  });
});
