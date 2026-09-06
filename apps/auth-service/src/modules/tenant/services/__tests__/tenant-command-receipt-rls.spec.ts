/**
 * ORPHAN-CRITICAL-573 — the receipt transaction must bind its RLS tenant
 * context before it touches `auth.tenant_command_receipts`.
 *
 * The table carries the standard isolation policy: a row is writable only
 * under `app.bypass_rls=on`, or when `app.current_tenant` equals its
 * `tenantId`. The transaction ran with neither, so the very first INSERT was
 * refused — and since the receipt is written before any provisioning step
 * executes, every tenant creation failed at step zero. Two production
 * tenants sat in PENDING with no schema for months because of it.
 *
 * What these tests pin is narrow and deliberate: the GUC is set, it is set
 * BEFORE the first receipt statement, it names the command's tenant, and it
 * is transaction-local. The last one is what makes this a fix rather than a
 * new bug — a session-wide setting on a pooled connection would leak this
 * tenant into the next caller's query.
 */
import { TenantStatus, type SuspendTenantLifecycleCommand } from '@platform/event-contracts';
import { IUserTokenRevocation } from '@aquaculture/backend-common/security';
import { OutboxPublisher } from '@platform/outbox';
import { collaborator, stub, stubMember } from '@platform/testing';
import { DataSource, Repository } from 'typeorm';

import { TenantProvisioningCommandService } from '../tenant-provisioning-command.service';
import { AuditLogService } from '../../../../audit/audit-log.service';
import { AuditLog } from '../../../../audit/audit-log.entity';
import { Invitation } from '../../../authentication/entities/invitation.entity';
import { User } from '../../../authentication/entities/user.entity';
import { DurableUserTokenInvalidationService } from '../../../authentication/services/durable-user-token-invalidation.service';
import { Tenant } from '../../entities/tenant.entity';

const TENANT_ID = '33333333-3333-4333-8333-333333333333';

interface MockManager {
  query: jest.Mock;
  findOne: jest.Mock;
  save: jest.Mock;
}

function createManager(): MockManager {
  return {
    query: jest.fn((sql: string) => {
      if (
        sql.includes('FROM auth.tenant_command_receipts') &&
        sql.trimStart().startsWith('SELECT')
      ) {
        return Promise.resolve([]);
      }
      if (sql.includes('SELECT id FROM "auth"."users"')) {
        return Promise.resolve([]);
      }
      return Promise.resolve([]);
    }),
    findOne: jest.fn(() =>
      Promise.resolve({ id: TENANT_ID, status: TenantStatus.ACTIVE, name: 'Canary Probe' }),
    ),
    save: jest.fn((_entity: unknown, value: unknown) => Promise.resolve(value)),
  };
}

function createService(manager: MockManager): TenantProvisioningCommandService {
  // `DataSource.transaction` is an overload set, so the single-signature mock
  // is named through `stubMember` — the one place the cast is allowed to live —
  // while every other member of the double stays fully checked.
  const dataSource = collaborator<DataSource>(
    {
      transaction: stubMember<DataSource['transaction']>(
        jest.fn((_isolation: string, cb: (m: MockManager) => Promise<unknown>) => cb(manager)),
      ),
    },
    'DataSource',
  );
  // Every collaborator is a TYPED double. The blanket casts these seven
  // arguments used to carry checked nothing: W5 added a seventh constructor
  // parameter and the suite stopped compiling instead of naming what was
  // missing, and before that a repository double that modelled no member at
  // all would have answered `undefined` to any call the service made. The
  // three repositories model no member ON PURPOSE — this flow works through
  // the transaction manager, so reaching a repository here is a defect, and
  // `collaborator` turns that into a named failure rather than a silent one.
  return new TenantProvisioningCommandService(
    collaborator<Repository<Tenant>>({}, 'Repository<Tenant>'),
    collaborator<Repository<User>>({}, 'Repository<User>'),
    collaborator<Repository<Invitation>>({}, 'Repository<Invitation>'),
    dataSource,
    collaborator<OutboxPublisher>({ enqueue: jest.fn(() => Promise.resolve()) }, 'OutboxPublisher'),
    collaborator<IUserTokenRevocation>(
      {
        revokeUserTokens: jest.fn(() => Promise.resolve()),
        isTokenValid: jest.fn(() => Promise.resolve(true)),
      },
      'IUserTokenRevocation',
    ),
    collaborator<DurableUserTokenInvalidationService>(
      {
        enqueue: jest.fn(() => Promise.resolve()),
        applyImmediately: jest.fn(() => Promise.resolve()),
      },
      'DurableUserTokenInvalidationService',
    ),
    // W5 added the localization audit trail as the seventh collaborator: a
    // change to `AuditLogService.log`'s shape now fails HERE at compile time.
    collaborator<AuditLogService>(
      { log: jest.fn(() => Promise.resolve(stub<AuditLog>({}))) },
      'AuditLogService',
    ),
  );
}

// The fixture is checked against the real command contract, so a renamed or
// retyped field breaks here instead of silently reaching the service as a
// shape it does not recognise.
const command = stub<SuspendTenantLifecycleCommand>({
  operationId: '44444444-4444-4444-8444-444444444444',
  tenantId: TENANT_ID,
  // 'SUPER_ADMIN' is not an actor TYPE — the contract's three types are
  // user/service/system, and a platform admin is a user. The blanket cast the
  // fixture used to carry accepted the wrong literal without complaint; the
  // service only ever reads `actor.id`, so nothing failed and nothing checked.
  actor: { id: 'platform-admin', type: 'user' },
  reason: 'canary provisioning',
});

function sqlOf(calls: unknown[][]): string[] {
  return calls.map(([sql]) => String(sql));
}

/** The binding is `set_config($1, $2, true)` with the GUC name as a parameter. */
function tenantGucCall(calls: unknown[][]): unknown[] | undefined {
  return calls.find(
    ([sql, params]) =>
      String(sql).includes('set_config') &&
      Array.isArray(params) &&
      params.includes('app.current_tenant'),
  );
}

describe('tenant command receipts run under an RLS tenant context', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('sets the tenant GUC before the first receipt statement', async () => {
    const manager = createManager();
    const service = createService(manager);

    await service.suspendTenant(command);

    const statements = sqlOf(manager.query.mock.calls);
    const gucIndex = manager.query.mock.calls.findIndex(
      ([sql, params]) =>
        String(sql).includes('set_config') &&
        Array.isArray(params) &&
        params.includes('app.current_tenant'),
    );
    const receiptIndex = statements.findIndex((sql) =>
      sql.includes('auth.tenant_command_receipts'),
    );

    expect(gucIndex).toBeGreaterThanOrEqual(0);
    expect(receiptIndex).toBeGreaterThanOrEqual(0);
    // Order is the whole point: a context set after the INSERT is a context
    // the INSERT never had.
    expect(gucIndex).toBeLessThan(receiptIndex);
  });

  it('binds the command tenant, not some ambient one', async () => {
    const manager = createManager();
    const service = createService(manager);

    await service.suspendTenant(command);

    const gucCall = tenantGucCall(manager.query.mock.calls);

    expect(gucCall?.[1]).toEqual(['app.current_tenant', TENANT_ID]);
  });

  it('forces bypass off in the same breath', async () => {
    // Binding the tenant while leaving a stale `app.bypass_rls=on` from a
    // previous audited path would satisfy the policy for EVERY row, which is
    // worse than the refusal being fixed.
    const manager = createManager();
    const service = createService(manager);

    await service.suspendTenant(command);

    const bypassCall = manager.query.mock.calls.find(
      ([sql, params]) =>
        String(sql).includes('set_config') &&
        Array.isArray(params) &&
        params.includes('app.bypass_rls'),
    );

    expect(bypassCall).toBeDefined();
    expect(String(bypassCall?.[0])).toContain("'off', true");
  });

  it('reads the settings back instead of trusting them', async () => {
    // A GUC that silently failed to apply produced an RLS refusal naming a
    // table and not a cause - which is why this stayed unexplained for months.
    const manager = createManager();
    const service = createService(manager);

    await service.suspendTenant(command);

    const readback = manager.query.mock.calls.find(([sql]) =>
      String(sql).includes('current_setting'),
    );

    expect(readback).toBeDefined();
  });

  it('keeps the setting transaction-local so a pooled connection cannot carry it', async () => {
    const manager = createManager();
    const service = createService(manager);

    await service.suspendTenant(command);

    const gucCall = tenantGucCall(manager.query.mock.calls);

    // Third argument `true` = local to the transaction. Without it the tenant
    // outlives the work on a pooled connection, which is a cross-tenant read
    // waiting to happen - strictly worse than the bug being fixed.
    expect(String(gucCall?.[0])).toContain('$2, true');
  });
});
