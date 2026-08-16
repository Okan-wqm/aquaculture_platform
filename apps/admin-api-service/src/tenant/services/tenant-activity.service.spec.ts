import type { DataSource, Repository } from 'typeorm';

import { ActivityType } from '../dto/tenant-activity.dto';
import type { TenantBillingInfo, TenantNote } from '../entities/tenant-activity.entity';

import { TenantActivityService } from './tenant-activity.service';

describe('TenantActivityService source-owner projection', () => {
  function serviceWithQuery(query: jest.Mock): TenantActivityService {
    return new TenantActivityService(
      { query } as unknown as DataSource,
      {} as Repository<TenantNote>,
      {} as Repository<TenantBillingInfo>,
    );
  }

  it('projects lifecycle activity from the immutable auth receipt authority', async () => {
    const query = jest.fn().mockResolvedValue([
      {
        id: '11111111-1111-4111-8111-111111111111',
        tenantId: '22222222-2222-4222-8222-222222222222',
        activityType: ActivityType.SUSPENDED,
        title: 'Tenant suspended',
        description: 'policy',
        metadata: {
          sourceAuthority: 'auth.tenant_command_receipts',
          commandType: 'SuspendTenant',
        },
        previousValue: { status: 'ACTIVE' },
        newValue: { status: 'SUSPENDED' },
        performedBy: '33333333-3333-4333-8333-333333333333',
        performedByEmail: null,
        createdAt: '2026-08-09T10:00:00.000Z',
        total: '1',
      },
    ]);
    const service = serviceWithQuery(query);

    await expect(
      service.getActivities('22222222-2222-4222-8222-222222222222', {
        activityTypes: [ActivityType.SUSPENDED],
        limit: 10,
        offset: 0,
      }),
    ).resolves.toEqual({
      items: [
        expect.objectContaining({
          activityType: ActivityType.SUSPENDED,
          title: 'Tenant suspended',
          performedBy: '33333333-3333-4333-8333-333333333333',
          createdAt: new Date('2026-08-09T10:00:00.000Z'),
        }),
      ],
      total: 1,
    });

    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain('auth.tenant_command_receipts');
    expect(sql).toContain("audit.action = 'LEGACY_TENANT_ACTIVITY_IMPORTED'");
    expect(sql).not.toContain('admin.tenant_activities');
  });

  it('fails closed on a malformed projection total', async () => {
    const service = serviceWithQuery(jest.fn().mockResolvedValue([{ total: 'not-a-count' }]));

    await expect(service.getActivities('22222222-2222-4222-8222-222222222222')).rejects.toThrow(
      'invalid total',
    );
  });
});
