import { createBaseEvent, TenantErasureRequestedEvent } from '@platform/event-contracts';

import { SensorTenantErasureHook } from '../sensor-tenant-erasure.hook';

const TENANT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function erasureEvent(): TenantErasureRequestedEvent {
  return {
    ...createBaseEvent<TenantErasureRequestedEvent>('TenantErasureRequested', TENANT_ID, {
      aggregateId: TENANT_ID,
      aggregateType: 'Tenant',
    }),
    operationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    requestedBy: 'platform-admin',
    requestedAt: '2026-08-25T12:00:00.000Z',
    legalHoldCheckedAt: '2026-08-25T12:00:00.000Z',
    dryRun: false,
    targetServiceCount: 12,
  };
}

describe('SensorTenantErasureHook', () => {
  it('removes directory routing and every sensor/MQTT cache for the tenant', async () => {
    const topicCache = { eraseTenantCache: jest.fn().mockResolvedValue(undefined) };
    const metaCache = { invalidateTenant: jest.fn() };
    const mqttAuth = { invalidateTenant: jest.fn() };
    const messageEraser = { eraseTenantMessages: jest.fn().mockResolvedValue(undefined) };
    const manager = { query: jest.fn().mockResolvedValue([]) };
    const hook = new SensorTenantErasureHook(topicCache, metaCache, mqttAuth, messageEraser);

    await hook.onTenantErased(erasureEvent(), manager as never);

    expect(manager.query).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM "sensor"."edge_device_directory"'),
      [TENANT_ID],
    );
    expect(topicCache.eraseTenantCache).toHaveBeenCalledWith(TENANT_ID);
    expect(metaCache.invalidateTenant).toHaveBeenCalledWith(TENANT_ID);
    expect(mqttAuth.invalidateTenant).toHaveBeenCalledWith(TENANT_ID);
    expect(messageEraser.eraseTenantMessages).toHaveBeenCalledWith(TENANT_ID);
  });

  it('propagates cache deletion failure so no erasure proof can commit', async () => {
    const hook = new SensorTenantErasureHook(
      { eraseTenantCache: jest.fn().mockRejectedValue(new Error('Redis unavailable')) },
      { invalidateTenant: jest.fn() },
      { invalidateTenant: jest.fn() },
      { eraseTenantMessages: jest.fn().mockResolvedValue(undefined) },
    );

    await expect(
      hook.onTenantErased(erasureEvent(), { query: jest.fn().mockResolvedValue([]) } as never),
    ).rejects.toThrow('Redis unavailable');
  });
});
