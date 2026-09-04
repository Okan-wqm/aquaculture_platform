/**
 * ADMIN-HIGH-009 — MessagingAdminController monitoring + tenants-overview proxy.
 *
 * London-school unit tests: the NATS ClientProxy and ConfigService are mocked.
 * Verifies the two former 501 endpoints now proxy to the exact
 * `request.messaging.admin.*` patterns messaging-service handles, pass an
 * empty payload (the aggregates are platform-wide), return the reply
 * unmodified, and map NATS timeouts to 504.
 */
import { HttpException, HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { of, throwError } from 'rxjs';

import { MessagingAdminController } from '../messaging-admin.controller';

describe('MessagingAdminController — monitoring endpoints (ADMIN-HIGH-009)', () => {
  let controller: MessagingAdminController;
  let send: jest.Mock;

  const monitoringStats = {
    totals: {
      totalMessages: 400,
      messages24h: 35,
      messages7d: 130,
      activeChannels: 10,
      tenantCount: 2,
    },
    perTenant: [
      {
        tenantId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        messageCount24h: 25,
        messageCount7d: 90,
        totalMessages: 300,
        activeChannels: 7,
      },
    ],
    outbox: { pendingCount: 4, failedCount: 2, oldestPendingAgeSeconds: 124 },
    generatedAt: '2026-07-13T00:00:00.000Z',
  };

  const tenantsOverview = {
    tenants: monitoringStats.perTenant,
    generatedAt: '2026-07-13T00:00:00.000Z',
  };

  beforeEach(async () => {
    send = jest.fn();
    const moduleRef = await Test.createTestingModule({
      controllers: [MessagingAdminController],
      providers: [
        { provide: 'MESSAGING_NATS_CLIENT', useValue: { send } },
        {
          provide: ConfigService,
          useValue: { get: jest.fn((_key: string, defaultValue: number) => defaultValue) },
        },
      ],
    }).compile();

    controller = moduleRef.get(MessagingAdminController);
  });

  it('GET /messaging/monitoring/stats proxies request.messaging.admin.getMonitoringStats', async () => {
    send.mockReturnValue(of(monitoringStats));

    await expect(controller.getMonitoringStats()).resolves.toEqual(monitoringStats);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('request.messaging.admin.getMonitoringStats', {});
  });

  it('GET /messaging/tenants proxies request.messaging.admin.getTenantsOverview', async () => {
    send.mockReturnValue(of(tenantsOverview));

    await expect(controller.getTenants()).resolves.toEqual(tenantsOverview);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('request.messaging.admin.getTenantsOverview', {});
  });

  it('maps a NATS timeout on getMonitoringStats to 504 Gateway Timeout', async () => {
    send.mockReturnValue(throwError(() => new Error('Timeout has occurred')));

    await expect(controller.getMonitoringStats()).rejects.toMatchObject({
      status: HttpStatus.GATEWAY_TIMEOUT,
    });
  });

  it('maps a NATS connection failure on getTenants to 503 Service Unavailable', async () => {
    send.mockReturnValue(throwError(() => new Error('NATS client not connected')));

    const failure = controller.getTenants();
    await expect(failure).rejects.toBeInstanceOf(HttpException);
    await expect(failure).rejects.toMatchObject({
      status: HttpStatus.SERVICE_UNAVAILABLE,
    });
  });
});
