export class GetDepartmentsQuery {
  constructor(
    public readonly tenantId: string,
    public readonly siteId?: string,
    public readonly isDeleted?: boolean,
  ) {}
}

export class GetDepartmentQuery {
  constructor(
    public readonly tenantId: string,
    public readonly id: string,
  ) {}
}
