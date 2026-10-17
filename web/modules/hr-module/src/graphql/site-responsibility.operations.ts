/**
 * Site responsibility — a farm-service read the Team area needs.
 *
 * WHY here: the Today page flags active sites nobody is responsible for. The
 * responsible persons are farm-service's `site_contacts` rows (one optionally
 * primary), exposed as the `Site.contacts` field resolver
 * (apps/farm-service/src/site/site.resolver.ts). hr-module must not import
 * farm-module code, so it asks the gateway for the federated field the same
 * way it already asks auth-service for `tenantUsers`; the root field is listed
 * in CROSS_SUBGRAPH_FIELDS (tests/invariants/hr-graphql-fe-be-parity.spec.ts).
 *
 * WHAT: every active site (`activeSites` is the bounded, complete active-site
 * read) with only the contact facts the gap check needs — no names, phones or
 * e-mails cross into the HR bundle.
 */
import { gql } from 'graphql-tag';

export const GET_SITE_RESPONSIBILITY = gql`
  query GetSiteResponsibility {
    activeSites {
      id
      name
      contacts {
        id
        isPrimary
      }
    }
  }
`;
