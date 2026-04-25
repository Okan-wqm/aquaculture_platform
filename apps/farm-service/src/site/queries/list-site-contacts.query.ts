/**
 * ListSiteContactsQuery — Scope A Phase 4.4.3.
 */
export class ListSiteContactsQuery {
  constructor(
    public readonly siteId: string,
    public readonly tenantId: string,
  ) {}
}
