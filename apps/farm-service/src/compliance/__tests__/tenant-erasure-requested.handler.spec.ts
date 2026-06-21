import { IEventBus } from '@platform/event-bus';
import type { TenantErasureRequestedEvent } from '@platform/event-contracts';

import { TenantErasureRequestedHandler } from '../tenant-erasure-requested.handler';
import { TenantErasureService } from '../services/tenant-erasure.service';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const OPERATION_ID = '33333333-3333-4333-8333-333333333333';

function eventFixture(): TenantErasureRequestedEvent {
  return {
    eventId: '44444444-4444-4444-8444-444444444444' as TenantErasureRequestedEvent['eventId'],
    eventType: 'TenantErasureRequested',
    timestamp: '2026-06-20T10:00:00.000Z',
    tenantId: TENANT_ID,
    version: 1,
    aggregateId: TENANT_ID,
    aggregateType: 'Tenant',
    operationId: OPERATION_ID,
    requestedBy: USER_ID,
    requestedAt: '2026-06-20T10:00:00.000Z',
    legalHoldCheckedAt: '2026-06-20T10:00:01.000Z',
    dryRun: false,
    targetServiceCount: 10,
  };
}

describe('TenantErasureRequestedHandler', () => {
  it('subscribes to TenantErasureRequested and delegates to TenantErasureService', async () => {
    const eventBus = {
      subscribeWildcard: jest.fn().mockResolvedValue(undefined),
    } as Pick<IEventBus, 'subscribeWildcard'> as IEventBus;
    const service = {
      eraseFromTenantErasureRequest: jest.fn().mockResolvedValue({
        tenantId: TENANT_ID,
        confirmedAt: '2026-06-20T10:00:02.000Z',
        deletedRowsByTable: {},
        totalDeleted: 0,
        matchedRecordCount: 0,
        auditRowsAnonymised: 0,
        state: 'PURGED',
      }),
    } as Pick<TenantErasureService, 'eraseFromTenantErasureRequest'> as TenantErasureService;

    const handler = new TenantErasureRequestedHandler(eventBus, service);
    await handler.onModuleInit();
    const event = eventFixture();
    await handler.handle(event);

    expect(eventBus.subscribeWildcard).toHaveBeenCalledWith(
      'TenantErasureRequested',
      handler,
    );
    expect(service.eraseFromTenantErasureRequest).toHaveBeenCalledWith(event);
  });
});
