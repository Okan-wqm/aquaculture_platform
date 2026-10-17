/**
 * How many messages the signed-in member has not read yet, for the company
 * dashboard's notices — the caller's own count, any tenant role.
 */
import { useTenantQuery } from '@aquaculture/shared-ui';
import type { UseQueryResult } from '@tanstack/react-query';

import { MEMBER_UNREAD_MESSAGES_QUERY } from '../graphql/member-queries';
import { graphqlRequest } from '../services/tenant-api.service';

const UNREAD_REFRESH_MS = 60_000;

export function useUnreadMessageCount(): UseQueryResult<number> {
  return useTenantQuery(
    ['companyHome', 'unreadMessages'],
    async (): Promise<number> =>
      (await graphqlRequest<{ totalUnreadMessageCount: number }>(MEMBER_UNREAD_MESSAGES_QUERY))
        .totalUnreadMessageCount,
    { staleTime: UNREAD_REFRESH_MS, refetchInterval: UNREAD_REFRESH_MS },
  );
}
