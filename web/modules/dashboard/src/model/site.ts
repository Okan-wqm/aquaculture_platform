/**
 * A site as every dashboard table reads it: the viewer's active sites
 * (farm-service activeSites, scoped to a module user's sites), in the
 * supergraph's own shape — the site type is the generated SiteType, so a new
 * type fails the build until its label exists.
 */
import type { SiteResponse } from '@platform/shared-ui/generated/graphql-types';

export type DashboardSite = Pick<SiteResponse, 'id' | 'code' | 'name' | 'type' | 'timezone'>;
