/**
 * The dashboard inbox's sources, each fetched only for a viewer its resolver
 * admits (model/inbox for the rules that turn them into notices):
 *  - seats — tenantBilling + tenantStats: the tenant admin's;
 *  - two-factor — tenantUsers: users:view holders (a tenant admin passes);
 *  - maintenance — myAnnouncements: the tenant admin's.
 * A source the viewer may not read is 'unavailable': its notice is never
 * drawn and nothing is requested.
 */
import { graphqlClient, useAuth, useTenantQuery } from '@aquaculture/shared-ui';
import type { UseQueryResult } from '@tanstack/react-query';

import type { AnnouncementRecord, SeatSources, UserRecord } from '../model/inbox';

import {
  MAINTENANCE_ANNOUNCEMENTS_QUERY,
  SEATS_QUERY,
  type DashboardOperationResults,
} from './dashboard.operations';
import { useTenantUsers } from './useTenantUsers';

const INBOX_REFRESH_MS = 5 * 60_000;
const REFRESH = { staleTime: INBOX_REFRESH_MS, refetchInterval: INBOX_REFRESH_MS } as const;

export interface InboxSources {
  readonly seats: UseQueryResult<SeatSources | null> | null;
  readonly users: UseQueryResult<readonly UserRecord[]> | null;
  readonly maintenance: UseQueryResult<readonly AnnouncementRecord[]> | null;
  /** Whether the viewer reviews access requests (roles:view) — the previewed item's audience. */
  readonly reviewsAccess: boolean;
}

export function useInbox(): InboxSources {
  const { isTenantAdmin, hasPermission } = useAuth();
  const users = useTenantUsers();

  const seats = useTenantQuery(
    ['dashboard', 'inbox', 'seats'],
    async ({ signal }): Promise<SeatSources | null> => {
      const data = await graphqlClient.request<DashboardOperationResults['DashboardSeats']>(
        SEATS_QUERY,
        undefined,
        { signal },
      );
      const limits = data.tenantBilling.planLimits;
      return limits === null || limits === undefined
        ? null
        : {
            maxUsers: limits.maxUsers,
            currentUsers: limits.currentUsers,
            pendingUsers: data.tenantStats.pendingUsers,
          };
    },
    { enabled: isTenantAdmin, ...REFRESH },
  );

  const maintenance = useTenantQuery(
    ['dashboard', 'inbox', 'maintenance'],
    async ({ signal }): Promise<readonly AnnouncementRecord[]> =>
      (
        await graphqlClient.request<DashboardOperationResults['DashboardMaintenance']>(
          MAINTENANCE_ANNOUNCEMENTS_QUERY,
          undefined,
          { signal },
        )
      ).myAnnouncements,
    { enabled: isTenantAdmin, ...REFRESH },
  );

  return {
    seats: isTenantAdmin ? seats : null,
    users,
    maintenance: isTenantAdmin ? maintenance : null,
    reviewsAccess: hasPermission('roles:view'),
  };
}
