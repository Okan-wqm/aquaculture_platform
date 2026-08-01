import { beforeEach, describe, expect, it, vi } from 'vitest';

const graphql = vi.hoisted(() => vi.fn());

vi.mock('../../services/api-client', () => ({
  apiClient: { graphql },
}));

import {
  ACTIVE_SITE_ACCESS_CATALOG_QUERY,
  ASSIGN_USER_TO_SITE_MUTATION,
  UNASSIGN_USER_FROM_SITE_MUTATION,
  USER_ASSIGNED_SITE_IDS_QUERY,
} from '../../graphql';
import {
  assignUserToSite,
  getActiveTenantSites,
  getUserAssignedSiteIds,
  unassignUserFromSite,
} from '../api';

describe('tenant-admin site-access API', () => {
  beforeEach(() => {
    graphql.mockReset();
  });

  it('reads and narrows the tenant-scoped active Site catalog', async () => {
    graphql.mockResolvedValue({
      activeSiteAccessCatalog: [
        {
          id: 'site-a',
          name: 'Fjord Alpha',
          code: 'A-1',
        },
      ],
    });

    await expect(getActiveTenantSites()).resolves.toEqual([
      { id: 'site-a', name: 'Fjord Alpha', code: 'A-1' },
    ]);
    expect(graphql).toHaveBeenCalledWith(ACTIVE_SITE_ACCESS_CATALOG_QUERY);
  });

  it('fails closed when the canonical catalog contains malformed or duplicate Sites', async () => {
    graphql.mockResolvedValueOnce({
      activeSiteAccessCatalog: [
        {
          id: 'site-a',
          name: '',
          code: 'A-1',
        },
      ],
    });
    await expect(getActiveTenantSites()).rejects.toThrow(
      'activeSiteAccessCatalog[0].name must be a non-empty string',
    );

    graphql.mockResolvedValueOnce({
      activeSiteAccessCatalog: [
        {
          id: 'site-a',
          name: 'Fjord Alpha',
          code: 'A-1',
        },
        {
          id: 'site-a',
          name: 'Duplicate Alpha',
          code: 'A-2',
        },
      ],
    });
    await expect(getActiveTenantSites()).rejects.toThrow('duplicate site id site-a');
  });

  it('does not page-walk into a second snapshot that could omit rows under catalog churn', async () => {
    graphql
      .mockResolvedValueOnce({
        activeSiteAccessCatalog: [
          { id: 'site-a', name: 'Fjord Alpha', code: 'A-1' },
          { id: 'site-b', name: 'Fjord Beta', code: 'B-1' },
        ],
      })
      .mockRejectedValueOnce(new Error('a second request would observe a different snapshot'));

    await expect(getActiveTenantSites()).resolves.toEqual([
      { id: 'site-a', name: 'Fjord Alpha', code: 'A-1' },
      { id: 'site-b', name: 'Fjord Beta', code: 'B-1' },
    ]);

    expect(graphql).toHaveBeenCalledTimes(1);
    expect(graphql).toHaveBeenCalledWith(ACTIVE_SITE_ACCESS_CATALOG_QUERY);
  });

  it('reads only the target user assignment IDs and rejects duplicate authority rows', async () => {
    graphql.mockResolvedValueOnce({ userAssignedSiteIds: ['site-a', 'site-b'] });
    await expect(getUserAssignedSiteIds('user-a')).resolves.toEqual(['site-a', 'site-b']);
    expect(graphql).toHaveBeenLastCalledWith(USER_ASSIGNED_SITE_IDS_QUERY, {
      userId: 'user-a',
    });

    graphql.mockResolvedValueOnce({ userAssignedSiteIds: ['site-a', 'site-a'] });
    await expect(getUserAssignedSiteIds('user-a')).rejects.toThrow(
      'duplicate assigned site id site-a',
    );
  });

  it('uses the canonical assign/unassign mutation variable shapes', async () => {
    const assigned = {
      success: true,
      message: 'Site assigned',
      userId: 'user-a',
      siteId: 'site-a',
    };
    graphql.mockResolvedValueOnce({ assignUserToSite: assigned });
    await expect(assignUserToSite('user-a', 'site-a')).resolves.toEqual(assigned);
    expect(graphql).toHaveBeenLastCalledWith(ASSIGN_USER_TO_SITE_MUTATION, {
      input: { userId: 'user-a', siteId: 'site-a' },
    });

    const removed = { ...assigned, message: 'Site removed' };
    graphql.mockResolvedValueOnce({ unassignUserFromSite: removed });
    await expect(unassignUserFromSite('user-a', 'site-a')).resolves.toEqual(removed);
    expect(graphql).toHaveBeenLastCalledWith(UNASSIGN_USER_FROM_SITE_MUTATION, {
      userId: 'user-a',
      siteId: 'site-a',
    });
  });

  it('rejects malformed mutation acknowledgements before hooks can trust them', async () => {
    graphql.mockResolvedValue({
      assignUserToSite: {
        success: true,
        message: '',
        userId: 'user-a',
        siteId: 'site-a',
      },
    });

    await expect(assignUserToSite('user-a', 'site-a')).rejects.toThrow(
      'siteAssignment.message must be a non-empty string',
    );
  });
});
