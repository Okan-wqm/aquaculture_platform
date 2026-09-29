/**
 * ORPHAN-HIGH-413 (third arm) — the eventBus subscribers must establish the
 * tenant frame too.
 *
 * `TenantExecutionContextModule` covers the `@MessagePattern` handlers, but
 * `TaskEventHandler` and `FeedingDailySummaryEventHandler` are subscribed
 * through `eventBus.subscribeWildcard(...)` in `onModuleInit`. Nest
 * interceptors never see those callbacks, so nothing seeds
 * AsyncLocalStorage and `RlsConnectionBootstrap` hands the pool the
 * deny-by-default GUC pair at checkout.
 *
 * Both handlers open with a `device_tokens` recipient lookup — an RLS-armed
 * tenant-column table. Under deny-by-default that lookup returns nothing and
 * the handler concludes, truthfully as far as it can tell, that the tenant has
 * no reachable devices: "No device tokens found ... skipping push". A silently
 * skipped notification is the worst shape of this defect, because nothing ever
 * errors.
 *
 * These tests assert the frame is present at the moment the repository is
 * read — the exact value `RlsConnectionBootstrap` propagates into
 * `app.current_tenant`.
 */
import { getRequestContext } from '@aquaculture/backend-common/logging';

import { FeedingDailySummaryEventHandler } from '../feeding-daily-summary.handler';
import { TaskEventHandler } from '../task-event.handler';

const TENANT_ID = '7d3f2b9a-8c41-4d9e-8b21-0f6c5e4a1b77';
const USER_ID = '11111111-2222-4333-8444-555555555555';

describe('ORPHAN-HIGH-413: notification eventBus subscribers run inside the tenant frame', () => {
  it('reads device_tokens for a task event inside the tenant frame', async () => {
    const observed: (string | undefined)[] = [];
    const deviceTokenRepository = {
      findOne: jest.fn(() => {
        observed.push(getRequestContext()?.tenantId);
        return Promise.resolve({ token: 'fcm-token-123' });
      }),
    };

    const handler = new TaskEventHandler(
      { dispatchCommandNotification: jest.fn().mockResolvedValue({ replayed: false }) } as never,
      { createNotification: jest.fn().mockResolvedValue(undefined) } as never,
      {} as never,
      deviceTokenRepository as never,
      { subscribeWildcard: jest.fn() } as never,
    );

    expect(getRequestContext()?.tenantId).toBeUndefined();

    await handler.handle({
      eventType: 'TaskAssigned',
      tenantId: TENANT_ID,
      taskId: '22222222-3333-4444-8555-666666666666',
      title: 'Feed pond 3',
      assignedTo: USER_ID,
      assignedBy: USER_ID,
    } as never);

    expect(deviceTokenRepository.findOne).toHaveBeenCalled();
    expect(observed.every((tenantId) => tenantId === TENANT_ID)).toBe(true);
    // The frame does not outlive the event.
    expect(getRequestContext()?.tenantId).toBeUndefined();
  });

  it('resolves daily-summary recipients inside the tenant frame', async () => {
    let observedTenantId: string | undefined;
    const queryBuilder = {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      getRawMany: jest.fn(() => {
        observedTenantId = getRequestContext()?.tenantId;
        return Promise.resolve([]);
      }),
    };
    const deviceTokenRepository = { createQueryBuilder: jest.fn(() => queryBuilder) };

    const handler = new FeedingDailySummaryEventHandler(
      { dispatchCommandNotification: jest.fn() } as never,
      { createNotification: jest.fn() } as never,
      deviceTokenRepository as never,
      { subscribeWildcard: jest.fn() } as never,
    );

    await handler.handle({
      tenantId: TENANT_ID,
      planDate: '2026-08-19',
      unitsPlanned: 4,
      unitsCompleted: 4,
      actualTotalKg: 12,
      plannedTotalKg: 12,
      underfedUnitCount: 0,
      missedMealCount: 0,
    } as never);

    expect(queryBuilder.getRawMany).toHaveBeenCalled();
    expect(observedTenantId).toBe(TENANT_ID);
    expect(getRequestContext()?.tenantId).toBeUndefined();
  });

  it('never opens a tenant frame for an event whose tenant is unusable', async () => {
    // The UUID guard runs BEFORE the frame is opened, so a malformed tenant is
    // dropped rather than turned into a thrown context error.
    const deviceTokenRepository = { findOne: jest.fn() };
    const handler = new TaskEventHandler(
      { dispatchCommandNotification: jest.fn() } as never,
      { createNotification: jest.fn() } as never,
      {} as never,
      deviceTokenRepository as never,
      { subscribeWildcard: jest.fn() } as never,
    );

    await expect(
      handler.handle({
        eventType: 'TaskAssigned',
        tenantId: 'not-a-uuid',
        taskId: '22222222-3333-4444-8555-666666666666',
      } as never),
    ).resolves.toBeUndefined();

    expect(deviceTokenRepository.findOne).not.toHaveBeenCalled();
  });
});
