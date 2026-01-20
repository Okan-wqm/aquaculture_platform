/**
 * Get Equipment Query
 */
export class GetEquipmentQuery {
  constructor(
    public readonly equipmentId: string,
    public readonly tenantId: string,
    public readonly includeRelations: boolean = false,
  ) {}
}
