/**
 * List slaughter facilities for the tenant (active only unless asked).
 */
export class ListSlaughterFacilitiesQuery {
  constructor(
    public readonly tenantId: string,
    public readonly includeInactive: boolean = false,
  ) {}
}
