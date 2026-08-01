/**
 * ListSiteContactsHandler — Unit Tests
 *
 * Reads flow through the fail-closed tenant boundary (`runInTenantRead`):
 * the contacts query runs inside an explicit read-only transaction whose
 * schema + RLS context are asserted before any row is read, so a lost
 * tenant context throws instead of silently returning the source schema.
 */
import { ForbiddenException } from '@nestjs/common';
import { createMockDataSource } from '@aquaculture/testing';
import { Role } from '@aquaculture/backend-common/decorators';
import { SiteAuthorizationService } from '@aquaculture/backend-common/security';

import { ListSiteContactsHandler } from '../handlers/list-site-contacts.handler';
import { ListSiteContactsQuery } from '../queries/list-site-contacts.query';
import { SiteContact } from '../entities/site-contact.entity';

describe('ListSiteContactsHandler', () => {
  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const siteId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const caller = {
    sub: 'user-1',
    roles: [Role.MODULE_USER],
    assignedSiteIds: [siteId],
  };

  it('returns site contacts read through the tenant boundary, primary first', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    const contacts = [
      { id: 'c1', tenantId, siteId, isPrimary: true },
      { id: 'c2', tenantId, siteId, isPrimary: false },
    ];
    (mockManager.find as jest.Mock).mockResolvedValueOnce(contacts);

    const handler = new ListSiteContactsHandler(mockDataSource, new SiteAuthorizationService());
    const result = await handler.execute(new ListSiteContactsQuery(siteId, tenantId, caller));

    expect(result).toEqual(contacts);
    expect(mockManager.find).toHaveBeenCalledWith(SiteContact, {
      where: { tenantId, siteId },
      order: {
        isPrimary: 'DESC',
        createdAt: 'ASC',
      },
    });
  });

  it('returns an empty list when the site has no contacts', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    (mockManager.find as jest.Mock).mockResolvedValueOnce([]);

    const handler = new ListSiteContactsHandler(mockDataSource, new SiteAuthorizationService());
    const result = await handler.execute(new ListSiteContactsQuery(siteId, tenantId, caller));

    expect(result).toEqual([]);
  });

  it('rejects an unassigned MODULE_USER before reading contact rows', async () => {
    const { mockDataSource } = createMockDataSource();
    const handler = new ListSiteContactsHandler(mockDataSource, new SiteAuthorizationService());

    await expect(
      handler.execute(
        new ListSiteContactsQuery(siteId, tenantId, {
          ...caller,
          assignedSiteIds: ['another-site'],
        }),
      ),
    ).rejects.toThrow(ForbiddenException);
    expect(mockDataSource.createQueryRunner).not.toHaveBeenCalled();
  });
});
