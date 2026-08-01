/**
 * SEC-HIGH-051 — canonical object-level site authorization SSoT unit tests.
 *
 * Pins the manager-bypass + assigned-site-allow + fail-closed shape that the
 * farm stock/WQ/storage/harvest/feeding handlers rely on.
 */
import { ForbiddenException } from '@nestjs/common';

import { Role } from '../../decorators/roles.decorator';
import { SiteAuthorizationService } from '../site-authorization.service';

const SITE_A = 'site-a';
const SITE_B = 'site-b';
const SUB = 'user-1';

describe('SiteAuthorizationService', () => {
  let service: SiteAuthorizationService;

  beforeEach(() => {
    service = new SiteAuthorizationService();
  });

  it('allows a MODULE_USER assigned to the resolved site (same-site allow)', () => {
    expect(() =>
      service.assertSiteAssignment({
        caller: { sub: SUB, roles: [Role.MODULE_USER], assignedSiteIds: [SITE_A] },
        siteId: SITE_A,
      }),
    ).not.toThrow();
  });

  it('denies a MODULE_USER NOT assigned to the resolved site (cross-site reject)', () => {
    expect(() =>
      service.assertSiteAssignment({
        caller: { sub: SUB, roles: [Role.MODULE_USER], assignedSiteIds: [SITE_B] },
        siteId: SITE_A,
      }),
    ).toThrow(ForbiddenException);
  });

  it('allows a MODULE_MANAGER via the canonical hierarchy bypass (empty assignedSiteIds)', () => {
    expect(() =>
      service.assertSiteAssignment({
        caller: { sub: SUB, roles: [Role.MODULE_MANAGER], assignedSiteIds: [] },
        siteId: SITE_A,
      }),
    ).not.toThrow();
  });

  it('allows a TENANT_ADMIN (hierarchy includes MODULE_MANAGER)', () => {
    expect(() =>
      service.assertSiteAssignment({
        caller: { sub: SUB, roles: [Role.TENANT_ADMIN] },
        siteId: SITE_A,
      }),
    ).not.toThrow();
  });

  it('allows a SUPER_ADMIN', () => {
    expect(() =>
      service.assertSiteAssignment({
        caller: { sub: SUB, roles: [Role.SUPER_ADMIN] },
        siteId: SITE_A,
      }),
    ).not.toThrow();
  });

  it('denies a MODULE_USER when siteId is null (unresolved site, fail-closed)', () => {
    expect(() =>
      service.assertSiteAssignment({
        caller: { sub: SUB, roles: [Role.MODULE_USER], assignedSiteIds: [SITE_A] },
        siteId: null,
      }),
    ).toThrow(ForbiddenException);
  });

  it('denies a MODULE_USER when siteId is undefined (unresolved site, fail-closed)', () => {
    expect(() =>
      service.assertSiteAssignment({
        caller: { sub: SUB, roles: [Role.MODULE_USER], assignedSiteIds: [SITE_A] },
        siteId: undefined,
      }),
    ).toThrow(ForbiddenException);
  });

  it('allows a MODULE_MANAGER even when siteId is null (manager bypass is site-independent)', () => {
    expect(() =>
      service.assertSiteAssignment({
        caller: { sub: SUB, roles: [Role.MODULE_MANAGER], assignedSiteIds: [] },
        siteId: null,
      }),
    ).not.toThrow();
  });

  it('denies a MODULE_USER with an absent assignedSiteIds set (fail-closed)', () => {
    expect(() =>
      service.assertSiteAssignment({
        caller: { sub: SUB, roles: [Role.MODULE_USER] },
        siteId: SITE_A,
      }),
    ).toThrow(ForbiddenException);
  });

  it('denies a non-owner with an empty role set (fail-closed)', () => {
    expect(() =>
      service.assertSiteAssignment({
        caller: { sub: SUB, roles: [], assignedSiteIds: [SITE_A] },
        siteId: SITE_A,
      }),
    ).not.toThrow();
    // sanity: empty role set is fine ONLY because the site is assigned; with a
    // foreign site it must deny.
    expect(() =>
      service.assertSiteAssignment({
        caller: { sub: SUB, roles: [], assignedSiteIds: [SITE_A] },
        siteId: SITE_B,
      }),
    ).toThrow(ForbiddenException);
  });

  it('denies a non-manager whose role is unknown to the hierarchy (fail-closed)', () => {
    expect(() =>
      service.assertSiteAssignment({
        // an unmapped role string never satisfies roleHasPermission
        caller: { sub: SUB, roles: ['SOMETHING_ELSE' as Role], assignedSiteIds: [SITE_B] },
        siteId: SITE_A,
      }),
    ).toThrow(ForbiddenException);
  });

  describe('resolveSiteScope', () => {
    it('returns tenant-wide access for MODULE_MANAGER and higher roles', () => {
      expect(
        service.resolveSiteScope({
          sub: SUB,
          roles: [Role.MODULE_MANAGER],
          assignedSiteIds: [],
        }),
      ).toEqual({ kind: 'TENANT' });

      expect(
        service.resolveSiteScope({
          sub: SUB,
          roles: [Role.TENANT_ADMIN],
        }),
      ).toEqual({ kind: 'TENANT' });
    });

    it('returns only the assigned site ids for MODULE_USER', () => {
      expect(
        service.resolveSiteScope({
          sub: SUB,
          roles: [Role.MODULE_USER],
          assignedSiteIds: [SITE_A, SITE_A, SITE_B],
        }),
      ).toEqual({ kind: 'ASSIGNED', siteIds: [SITE_A, SITE_B] });
    });

    it('returns an empty assigned scope when assignedSiteIds is absent or empty', () => {
      expect(
        service.resolveSiteScope({
          sub: SUB,
          roles: [Role.MODULE_USER],
        }),
      ).toEqual({ kind: 'ASSIGNED', siteIds: [] });

      expect(
        service.resolveSiteScope({
          sub: SUB,
          roles: [Role.MODULE_USER],
          assignedSiteIds: [],
        }),
      ).toEqual({ kind: 'ASSIGNED', siteIds: [] });
    });
  });
});
