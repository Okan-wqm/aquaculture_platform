import { Test } from '@nestjs/testing';
import { createBaseEvent, type TenantProvisionedEvent } from '@platform/event-contracts';
import { DataSource } from 'typeorm';

import { DefaultPolicyProvisioningHandler } from '../default-policy-provisioning.handler';
import { EscalationPolicyService } from '../escalation-policy.service';

/**
 * ALERT-CRITICAL-004 — the edge trigger of the default-policy seed. The seed
 * itself (tenant transaction, ON CONFLICT, RLS) is proven on Postgres in
 * `farm-signal-delivery.postgres.spec.ts`; this spec pins the event contract.
 */
function event(tenantId: string): TenantProvisionedEvent {
  return {
    ...createBaseEvent<TenantProvisionedEvent>('TenantProvisioned', tenantId),
    operationId: 'op-1',
    name: 'Tenant',
    slug: 'tenant',
  };
}

describe('DefaultPolicyProvisioningHandler', () => {
  const dataSource = {
    createQueryRunner: jest.fn(() => {
      throw new Error('the seed must not start for a refused event');
    }),
  };
  const bus = { subscribeWildcard: jest.fn(async () => undefined) };
  let handler: DefaultPolicyProvisioningHandler;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        DefaultPolicyProvisioningHandler,
        { provide: DataSource, useValue: dataSource },
        { provide: EscalationPolicyService, useValue: { invalidateCache: jest.fn() } },
        { provide: 'EVENT_BUS', useValue: bus },
      ],
    }).compile();
    handler = moduleRef.get(DefaultPolicyProvisioningHandler);
  });

  it("subscribes to every tenant's TenantProvisioned", async () => {
    await handler.onModuleInit();
    expect(bus.subscribeWildcard).toHaveBeenCalledWith('TenantProvisioned', handler);
  });

  it.each(['system', 'not-a-uuid', ''])(
    'dead-letters an event whose tenancy scope is %p without touching the database',
    async (tenantId) => {
      // SCENARIO: a platform-scoped or malformed TenantProvisioned.
      // EXPECTS: terminate (a schema name can only come from a tenant UUID).
      const outcome = await handler.handle({
        ...event('11111111-1111-4111-8111-111111111111'),
        tenantId,
      });
      expect(outcome).toEqual(expect.objectContaining({ kind: 'terminate' }));
      expect(dataSource.createQueryRunner).not.toHaveBeenCalled();
    },
  );
});
