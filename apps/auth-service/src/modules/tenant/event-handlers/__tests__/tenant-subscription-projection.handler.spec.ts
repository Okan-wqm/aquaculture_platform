import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import {
  TenantPlan,
  createBaseEvent,
  type TenantSubscriptionChangedEvent,
} from '@platform/event-contracts';

import { Tenant } from '../../entities/tenant.entity';
import { TenantSubscriptionProjectionHandler } from '../tenant-subscription-projection.handler';

/**
 * DATA-LOW-001 — auth.tenants mirrors billing.subscriptions (the SSoT) by
 * consuming TenantSubscriptionChanged. The handler is a one-way projection.
 */
describe('TenantSubscriptionProjectionHandler (DATA-LOW-001)', () => {
  const TENANT_ID = '7f6b08ab-90e2-46d3-8a1b-1c2d3e4f5a6b';

  let update: jest.Mock;
  let subscribeWildcard: jest.Mock;
  let handler: TenantSubscriptionProjectionHandler;

  const makeEvent = (
    fields: Partial<TenantSubscriptionChangedEvent>,
  ): TenantSubscriptionChangedEvent => ({
    ...createBaseEvent<TenantSubscriptionChangedEvent>('TenantSubscriptionChanged', TENANT_ID),
    previousPlan: 'starter',
    newPlan: 'professional',
    effectiveDate: '2026-06-12T00:00:00.000Z',
    ...fields,
  });

  beforeEach(async () => {
    update = jest.fn().mockResolvedValue({ affected: 1 });
    subscribeWildcard = jest.fn().mockResolvedValue(undefined);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TenantSubscriptionProjectionHandler,
        { provide: getRepositoryToken(Tenant), useValue: { update } },
        { provide: 'EVENT_BUS', useValue: { subscribeWildcard } },
      ],
    }).compile();

    handler = module.get<TenantSubscriptionProjectionHandler>(TenantSubscriptionProjectionHandler);
  });

  it('subscribes to TenantSubscriptionChanged on boot', async () => {
    await handler.onModuleInit();
    expect(subscribeWildcard).toHaveBeenCalledWith('TenantSubscriptionChanged', handler);
  });

  it('projects plan + trial + subscription end onto auth.tenants', async () => {
    const trialEndsAt = new Date('2026-07-01T00:00:00.000Z');
    const subscriptionEndsAt = new Date('2027-06-12T00:00:00.000Z');
    await handler.handle(
      makeEvent({
        newPlan: TenantPlan.ENTERPRISE,
        trialEndsAt,
        subscriptionEndsAt,
      }),
    );
    expect(update).toHaveBeenCalledWith(
      { id: TENANT_ID },
      { plan: TenantPlan.ENTERPRISE, trialEndsAt, subscriptionEndsAt },
    );
  });

  it('projects an explicit null trial window (trial ended)', async () => {
    await handler.handle(makeEvent({ trialEndsAt: null }));
    expect(update).toHaveBeenCalledWith(
      { id: TENANT_ID },
      expect.objectContaining({ trialEndsAt: null }),
    );
  });

  it('skips the plan but still projects dates for an unknown plan string', async () => {
    await handler.handle(makeEvent({ newPlan: 'legacy-unknown', subscriptionEndsAt: null }));
    // The exact patch proves the unknown plan was skipped (no `plan` key) while
    // the date it carried is still projected; the event sets no trialEndsAt.
    expect(update).toHaveBeenCalledWith({ id: TENANT_ID }, { subscriptionEndsAt: null });
  });

  it('refuses an invalid tenantId without touching the database', async () => {
    await handler.handle(makeEvent({ tenantId: 'not-a-uuid' }));
    expect(update).not.toHaveBeenCalled();
  });

  it('does not throw when the tenant row is absent (affected=0)', async () => {
    update.mockResolvedValue({ affected: 0 });
    await expect(handler.handle(makeEvent({}))).resolves.toEqual({ kind: 'ack' });
  });
});
