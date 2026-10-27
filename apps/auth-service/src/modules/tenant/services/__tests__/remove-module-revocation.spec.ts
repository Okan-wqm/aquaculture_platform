/**
 * RemoveModule revokes the tokens of everyone holding the module (PKG-06; RBAC-HIGH-035;
 * ADR-051 §2 "Change").
 *
 * Before PKG-06 RemoveModule only flipped tenant_modules.isEnabled: the module-access reader drops
 * a disabled module from the next token, but every live access token kept it until it expired.
 * These specs pin the governed command's contract:
 *   - in the receipt transaction that disables the module, every holder — each member with a live
 *     grant in it and each tenant administrator, who holds every enabled module through the
 *     account role — gets a durable access-token invalidation, and one audit row records the
 *     removal, both through the transaction's manager;
 *   - after commit the live tokens are cut at once; a failure there is not fatal (the durable
 *     intent is replayed by the auth consumer);
 *   - a module that was already disabled, or an idempotent replay, revokes and audits nothing.
 */
import type { RemoveTenantModuleCommand } from '@platform/event-contracts';
import { collaborator, stub, stubMember } from '@aquaculture/testing';
import { Logger } from '@nestjs/common';
import type { DataSource, EntityManager } from 'typeorm';

import { AuditLog } from '../../../../audit/audit-log.entity';
import type { AuditLogService, CreateAuditLogDto } from '../../../../audit/audit-log.service';
import type {
  DurableUserTokenInvalidationService,
  UserTokenInvalidationIntent,
} from '../../../authentication/services/durable-user-token-invalidation.service';
import { MODULE_HOLDERS_SQL } from '../module-removal-revocation';
import { TenantProvisioningCommandService } from '../tenant-provisioning-command.service';

const TENANT_ID = '33333333-3333-4333-8333-333333333333';
const MODULE_ID = '10000000-0000-4000-8000-000000000001';
const MEMBER = '11111111-1111-4111-8111-111111111111';
const ADMIN = '22222222-2222-4222-8222-222222222222';

const command: RemoveTenantModuleCommand = {
  operationId: '44444444-4444-4444-8444-444444444444',
  tenantId: TENANT_ID,
  moduleId: MODULE_ID,
  actor: { id: '55555555-5555-4555-8555-555555555555', type: 'user' },
};

interface Harness {
  readonly service: TenantProvisioningCommandService;
  readonly manager: EntityManager;
  readonly queries: Array<{ sql: string; parameters: readonly unknown[] }>;
  readonly enqueued: Array<{ intent: UserTokenInvalidationIntent; inTransaction: boolean }>;
  readonly audits: Array<{ dto: CreateAuditLogDto; inTransaction: boolean }>;
  readonly applied: jest.Mock;
}

function harness(options: {
  /** What the UPDATE … RETURNING of the module row answers, in TypeORM's [rows, count] shape. */
  readonly disabled: readonly [ReadonlyArray<{ id: string }>, number];
  readonly holders: ReadonlyArray<{ id: string; tenantId: string; role: string }>;
  readonly priorReceipt?: { payloadHash: string; status: 'SUCCEEDED'; resultSummary: unknown };
}): Harness {
  const queries: Array<{ sql: string; parameters: readonly unknown[] }> = [];
  const enqueued: Array<{ intent: UserTokenInvalidationIntent; inTransaction: boolean }> = [];
  const audits: Array<{ dto: CreateAuditLogDto; inTransaction: boolean }> = [];
  let inTransaction = false;

  const manager = stub<EntityManager>({
    query: stubMember<EntityManager['query']>((sql: string, parameters?: unknown[]) => {
      queries.push({ sql, parameters: parameters ?? [] });
      if (
        sql.includes('FROM auth.tenant_command_receipts') &&
        sql.trimStart().startsWith('SELECT')
      ) {
        return Promise.resolve(options.priorReceipt === undefined ? [] : [options.priorReceipt]);
      }
      if (sql.includes('UPDATE auth.tenant_modules')) return Promise.resolve(options.disabled);
      if (sql === MODULE_HOLDERS_SQL) return Promise.resolve(options.holders);
      return Promise.resolve([]);
    }),
    findOne: stubMember<EntityManager['findOne']>(() =>
      Promise.resolve({ id: TENANT_ID, status: 'ACTIVE' }),
    ),
  });
  const dataSource = stub<DataSource>({
    transaction: stubMember<DataSource['transaction']>(
      async (_isolation: string, work: (transactionManager: EntityManager) => Promise<unknown>) => {
        inTransaction = true;
        try {
          return await work(manager);
        } finally {
          inTransaction = false;
        }
      },
    ),
  });
  const applied = jest.fn().mockResolvedValue(undefined);
  const durable = collaborator<DurableUserTokenInvalidationService>(
    {
      enqueue: jest.fn((intentManager: EntityManager, intent: UserTokenInvalidationIntent) => {
        enqueued.push({ intent, inTransaction: inTransaction && intentManager === manager });
        return Promise.resolve();
      }),
      applyImmediately: applied,
    },
    'DurableUserTokenInvalidationService',
  );
  const auditLogService = collaborator<AuditLogService>(
    {
      log: jest.fn((dto: CreateAuditLogDto, auditManager?: unknown) => {
        audits.push({ dto, inTransaction: inTransaction && auditManager === manager });
        return Promise.resolve(Object.assign(new AuditLog(), dto));
      }),
    },
    'AuditLogService',
  );
  const service = new TenantProvisioningCommandService(
    collaborator({}, 'Tenant repository'),
    collaborator({}, 'User repository'),
    collaborator({}, 'Invitation repository'),
    dataSource,
    collaborator({}, 'OutboxPublisher'),
    collaborator({}, 'IUserTokenRevocation'),
    auditLogService,
    durable,
  );
  return { service, manager, queries, enqueued, audits, applied };
}

describe('TenantProvisioningCommandService.removeTenantModule — revocation (RBAC-HIGH-035)', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  it('invalidates every holder of the module and audits the removal, in the receipt transaction', async () => {
    const world = harness({
      disabled: [[{ id: 'tm-farm' }], 1],
      holders: [
        { id: MEMBER, tenantId: TENANT_ID, role: 'MODULE_USER' },
        { id: ADMIN, tenantId: TENANT_ID, role: 'TENANT_ADMIN' },
      ],
    });

    const result = await world.service.removeTenantModule(command);

    expect(result).toEqual({ modulesRemoved: 1 });
    expect(world.queries.find((query) => query.sql === MODULE_HOLDERS_SQL)?.parameters).toEqual([
      TENANT_ID,
      MODULE_ID,
    ]);
    expect(world.enqueued).toEqual([
      {
        inTransaction: true,
        intent: expect.objectContaining({
          userId: MEMBER,
          tenantId: TENANT_ID,
          reason: 'role_permissions_changed',
        }),
      },
      {
        inTransaction: true,
        intent: expect.objectContaining({
          userId: ADMIN,
          tenantId: TENANT_ID,
          reason: 'role_permissions_changed',
        }),
      },
    ]);
    expect(world.audits).toEqual([
      {
        inTransaction: true,
        dto: expect.objectContaining({
          tenantId: TENANT_ID,
          performedBy: command.actor.id,
          action: 'TENANT_MODULE_REMOVED',
          entityType: 'TenantModule',
          entityId: 'tm-farm',
          previousValue: { moduleId: MODULE_ID, isEnabled: true },
          newValue: { moduleId: MODULE_ID, isEnabled: false },
          details: { membersInvalidated: 2 },
        }),
      },
    ]);
    // After commit the request path cuts the live tokens at once.
    expect(world.applied.mock.calls).toEqual([
      [world.enqueued[0]?.intent],
      [world.enqueued[1]?.intent],
    ]);
  });

  it('still answers when the immediate invalidation fails after commit (the durable intent stands)', async () => {
    const world = harness({
      disabled: [[{ id: 'tm-farm' }], 1],
      holders: [{ id: MEMBER, tenantId: TENANT_ID, role: 'MODULE_USER' }],
    });
    world.applied.mockRejectedValueOnce(new Error('redis down'));

    await expect(world.service.removeTenantModule(command)).resolves.toEqual({
      modulesRemoved: 1,
    });
    expect(world.enqueued).toHaveLength(1);
  });

  it('revokes and audits nothing when the module was already disabled', async () => {
    const world = harness({
      disabled: [[], 0],
      holders: [{ id: MEMBER, tenantId: TENANT_ID, role: 'MODULE_USER' }],
    });

    const result = await world.service.removeTenantModule(command);

    expect(result).toEqual({ modulesRemoved: 0 });
    expect(world.queries.some((query) => query.sql === MODULE_HOLDERS_SQL)).toBe(false);
    expect(world.enqueued).toEqual([]);
    expect(world.audits).toEqual([]);
    expect(world.applied).not.toHaveBeenCalled();
  });

  it('revokes nothing again on an idempotent replay of a command that already succeeded', async () => {
    const live = harness({
      disabled: [[{ id: 'tm-farm' }], 1],
      holders: [{ id: MEMBER, tenantId: TENANT_ID, role: 'MODULE_USER' }],
    });
    await live.service.removeTenantModule(command);
    const receipt = live.queries.find((query) =>
      query.sql.includes('INSERT INTO auth.tenant_command_receipts'),
    );
    const payloadHash = receipt?.parameters[5];
    expect(typeof payloadHash).toBe('string');

    const replay = harness({
      disabled: [[{ id: 'tm-farm' }], 1],
      holders: [{ id: MEMBER, tenantId: TENANT_ID, role: 'MODULE_USER' }],
      priorReceipt: {
        payloadHash: String(payloadHash),
        status: 'SUCCEEDED',
        resultSummary: { modulesRemoved: 1 },
      },
    });

    await expect(replay.service.removeTenantModule(command)).resolves.toEqual({
      modulesRemoved: 1,
    });
    expect(replay.enqueued).toEqual([]);
    expect(replay.audits).toEqual([]);
    expect(replay.applied).not.toHaveBeenCalled();
  });
});
