/**
 * Get Department Query
 */
export class GetDepartmentQuery {
  constructor(
    public readonly departmentId: string,
    public readonly tenantId: string,
    public readonly includeRelations: boolean = false,
  ) {}
}
