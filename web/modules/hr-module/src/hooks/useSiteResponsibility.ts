/**
 * Site responsibility hook — which active sites have a responsible person.
 *
 * Reads farm-service's `activeSites { contacts }` through the gateway (see
 * GET_SITE_RESPONSIBILITY for why hr-module may ask farm-service). Built on
 * the shared useTenantQuery SSoT, so the key carries the tenant prefix and the
 * request waits for an authenticated tenant session.
 */
import type { UseQueryResult } from '@tanstack/react-query';
import { graphqlClient, useTenantQuery } from '@aquaculture/shared-ui';

import { GET_SITE_RESPONSIBILITY } from '../graphql/site-responsibility.operations';
import { graphqlRequest } from './useGraphQL';

/** One site_contacts row, reduced to what the gap check reads. */
export interface SiteContactFlag {
  id: string;
  isPrimary: boolean;
}

/** An active site with its responsible persons. */
export interface SiteResponsibility {
  id: string;
  name: string;
  contacts: SiteContactFlag[];
}

export function useSiteResponsibility(): UseQueryResult<SiteResponsibility[]> {
  return useTenantQuery(['hr', 'siteResponsibility', 'activeSites'], async () => {
    const data = await graphqlRequest<{ activeSites: SiteResponsibility[] }, undefined>(
      graphqlClient,
      GET_SITE_RESPONSIBILITY,
    );
    return data.activeSites;
  });
}
