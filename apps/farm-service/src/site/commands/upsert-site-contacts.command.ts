import type { SiteContactInput } from '../dto/site-contact.input';

/**
 * UpsertSiteContactsCommand — Scope A Phase 4.4.3.
 *
 * Replaces the FULL contact list for a site. Same DELETE+INSERT
 * semantics as `SetSupplierApprovedSitesCommand` — the operator's
 * mental model is "the form's contact rows ARE the site's contact
 * rows", so the command is a clean swap rather than a per-row diff.
 */
export class UpsertSiteContactsCommand {
  constructor(
    public readonly siteId: string,
    public readonly contacts: readonly SiteContactInput[],
    public readonly tenantId: string,
    public readonly userId: string,
  ) {}
}
