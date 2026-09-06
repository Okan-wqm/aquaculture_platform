/**
 * `WaterQualityService.assertUnitsSiteAuthorized` (W8 — FARM-MEDIUM-274)
 *
 * `effectiveUnitTemperatures` rol kapısında MODULE_USER'a açıktı ama NESNE
 * düzeyinde hiçbir kontrol yoktu: operatör atanmadığı bir sitenin ünite
 * kimliklerini geçirip o ünitelerin sıcaklık + sensör kimliklerini
 * okuyabiliyordu. Aynı SEC-HIGH-051 disiplini burada da uygulanır.
 *
 * `runInTenantRead` mock'lanır: burada denetlenen şey sorgu değil KARARdır
 * (kim geçer, kim geçmez, çözülemeyen site ne olur).
 */
import { ForbiddenException } from '@nestjs/common';

const runInTenantRead = jest.fn();
const resolveUnitSiteIds = jest.fn();

// Yalnız `runInTenantRead` değiştirilir: modülün tamamını ezmek entity
// dekoratörlerinin kullandığı DecimalTransformer'ı da silerdi.
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
const UNIT_IN_SCOPE = '22222222-2222-4222-8222-222222222222';
const UNIT_UNASSIGNED = '33333333-3333-4333-8333-333333333333';
const SITE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SITE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

/**
 * The service is exercised through its public method only; every collaborator
 * it does NOT touch on this path stays undefined, which is exactly what a
 * London-school double should be.
 */
function makeService(siteByUnit: Map<string, string>): WaterQualityService {
  runInTenantRead.mockReset();
  resolveUnitSiteIds.mockReset();
  resolveUnitSiteIds.mockResolvedValue(siteByUnit);
  runInTenantRead.mockImplementation(
    async (_ds: unknown, _schema: unknown, _tenant: unknown, fn: (qr: unknown) => unknown) =>
      fn({ manager: {} }),
  );

  const service = Object.create(WaterQualityService.prototype) as WaterQualityService;
  Object.assign(service, {
    dataSource: {},
    siteAuth: new SiteAuthorizationService(),
  });
  return service;
}

describe('WaterQualityService.assertUnitsSiteAuthorized', () => {
  it('lets a MODULE_MANAGER through without touching the database', async () => {
    const service = makeService(new Map());

    await expect(
      service.assertUnitsSiteAuthorized(TENANT, [UNIT_UNASSIGNED], {
        sub: 'u-1',
        roles: [Role.MODULE_MANAGER],
      }),
    ).resolves.toBeUndefined();
    // Cross-site sahibi — tek sorgu bile atılmaz.
    expect(runInTenantRead).not.toHaveBeenCalled();
  });

  it('allows a MODULE_USER for units inside an assigned site', async () => {
    const service = makeService(new Map([[UNIT_IN_SCOPE, SITE_A]]));

    await expect(
      service.assertUnitsSiteAuthorized(TENANT, [UNIT_IN_SCOPE], {
        sub: 'u-2',
        roles: [Role.MODULE_USER],
        assignedSiteIds: [SITE_A],
      }),
    ).resolves.toBeUndefined();
  });

  it('denies a MODULE_USER for a unit in a site they are not assigned to', async () => {
    const service = makeService(new Map([[UNIT_UNASSIGNED, SITE_B]]));

    await expect(
      service.assertUnitsSiteAuthorized(TENANT, [UNIT_UNASSIGNED], {
        sub: 'u-2',
        roles: [Role.MODULE_USER],
        assignedSiteIds: [SITE_A],
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('denies a unit whose site cannot be resolved — never an implicit allow', async () => {
    // Boş harita = ünite çözülemedi (departmanı yok / departmanın sitesi yok).
    const service = makeService(new Map());

    await expect(
      service.assertUnitsSiteAuthorized(TENANT, [UNIT_IN_SCOPE], {
        sub: 'u-2',
        roles: [Role.MODULE_USER],
        assignedSiteIds: [SITE_A],
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('denies the WHOLE batch when one unit sits outside the assigned sites (no silent filtering)', async () => {
    const service = makeService(
      new Map([
        [UNIT_IN_SCOPE, SITE_A],
        [UNIT_UNASSIGNED, SITE_B],
      ]),
    );

    // Yetkisiz kimlikleri sessizce süzmek operatöre "bu ünitenin sıcaklığı yok"
    // diye YANLIŞ bir cevap verirdi; yazma yolundaki per-item assert deseniyle
    // simetrik olarak reddedilir.
    await expect(
      service.assertUnitsSiteAuthorized(TENANT, [UNIT_IN_SCOPE, UNIT_UNASSIGNED], {
        sub: 'u-2',
        roles: [Role.MODULE_USER],
        assignedSiteIds: [SITE_A],
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('short-circuits an empty unit list', async () => {
    const service = makeService(new Map());

    await expect(
      service.assertUnitsSiteAuthorized(TENANT, [], {
        sub: 'u-2',
        roles: [Role.MODULE_USER],
        assignedSiteIds: [SITE_A],
      }),
    ).resolves.toBeUndefined();
    expect(runInTenantRead).not.toHaveBeenCalled();
  });
});
