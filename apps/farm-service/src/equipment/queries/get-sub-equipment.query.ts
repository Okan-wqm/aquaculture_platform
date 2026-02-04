/**
 * Get SubEquipment Query
 */
export class GetSubEquipmentQuery {
  constructor(
    public readonly id: string,
    public readonly tenantId: string,
    public readonly includeRelations: boolean = false,
  ) {}
}
