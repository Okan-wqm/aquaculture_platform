/**
 * Which active sites have nobody answerable for them.
 *
 * farm-service's `site_contacts` holds a site's responsible persons; at most
 * one is primary (upsertSiteContacts enforces that) and zero is allowed. The
 * Today page flags both gaps: no contact at all, and contacts with none marked
 * primary. No backend query answers this directly, so the filter runs here over
 * the complete `activeSites` read.
 */
import type { SiteResponsibility } from '../../hooks/useSiteResponsibility';

export type SiteGap = 'noContact' | 'noPrimary';

export interface UnassignedSite {
  id: string;
  name: string;
  gap: SiteGap;
  contactCount: number;
}

export function unassignedSites(sites: readonly SiteResponsibility[]): UnassignedSite[] {
  const flagged: UnassignedSite[] = [];
  for (const site of sites) {
    if (site.contacts.some((contact) => contact.isPrimary)) continue;
    flagged.push({
      id: site.id,
      name: site.name,
      gap: site.contacts.length === 0 ? 'noContact' : 'noPrimary',
      contactCount: site.contacts.length,
    });
  }
  return flagged;
}
