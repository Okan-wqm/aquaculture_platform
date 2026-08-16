import { ForbiddenException } from '@nestjs/common';

const runInTenantRead = jest.fn();
const resolveUnitSiteIds = jest.fn();

jest.mock('@aquaculture/backend-common/database', () => ({
  ...jest.requireActual<Record<string, unknown>>('@aquaculture/backend-common/database'),
  runInTenantRead: (...args: unknown[]): unknown => runInTenantRead(...args),
}));
jest.mock('../../batch/utils/tank-lookup.util', () => ({
  ...jest.requireActual<Record<string, unknown>>('../../batch/utils/tank-lookup.util'),
  resolveUnitSiteIds: (...args: unknown[]): unknown => resolveUnitSiteIds(...args),
}));

import { Role } from '@aquaculture/backend-common/decorators';
import { SiteAuthorizationService } from '@aquaculture/backend-common/security';

import { WaterQualityService } from '../water-quality.service';

const TENANT = '11111111-1111-4111-8111-111111111111';
const UNIT_A = '22222222-2222-4222-8222-222222222222';
const UNIT_B = '33333333-3333-4333-8333-333333333333';
const SITE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SITE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function makeService(siteByUnit: ReadonlyMap<string, string>): WaterQualityService {
  runInTenantRead.mockReset();
  resolveUnitSiteIds.mockReset();
  resolveUnitSiteIds.mockResolvedValue(siteByUnit);
  runInTenantRead.mockImplementation(
    async (_dataSource: unknown, _schema: unknown, _tenant: unknown, read: (runner: unknown) => unknown) =>
      read({ manager: {} }),
  );

  const service = Object.create(WaterQualityService.prototype) as WaterQualityService;
  Object.assign(service, {
    dataSource: {},
    siteAuth: new SiteAuthorizationService(),
  });
  return service;
}

describe('WaterQualityService.assertUnitsSiteAuthorized', () => {
  it('lets a manager through without a database read', async () => {
    const service = makeService(new Map());

    await expect(
      service.assertUnitsSiteAuthorized(TENANT, [UNIT_A], {
        sub: 'manager',
        roles: [Role.MODULE_MANAGER],
      }),
    ).resolves.toBeUndefined();
    expect(runInTenantRead).not.toHaveBeenCalled();
  });

  it('allows an assigned user and resolves duplicate units only once', async () => {
    const service = makeService(new Map([[UNIT_A, SITE_A]]));

    await expect(
      service.assertUnitsSiteAuthorized(TENANT, [UNIT_A, UNIT_A], {
        sub: 'operator',
        roles: [Role.MODULE_USER],
        assignedSiteIds: [SITE_A],
      }),
    ).resolves.toBeUndefined();
    expect(resolveUnitSiteIds).toHaveBeenCalledWith(expect.anything(), [UNIT_A], TENANT);
  });

  it('rejects the whole request when one unit belongs to another site', async () => {
    const service = makeService(
      new Map([
        [UNIT_A, SITE_A],
        [UNIT_B, SITE_B],
      ]),
    );

    await expect(
      service.assertUnitsSiteAuthorized(TENANT, [UNIT_A, UNIT_B], {
        sub: 'operator',
        roles: [Role.MODULE_USER],
        assignedSiteIds: [SITE_A],
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('fails closed when a requested unit has no resolvable site', async () => {
    const service = makeService(new Map());

    await expect(
      service.assertUnitsSiteAuthorized(TENANT, [UNIT_A], {
        sub: 'operator',
        roles: [Role.MODULE_USER],
        assignedSiteIds: [SITE_A],
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
